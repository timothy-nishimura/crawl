import { fetch, Agent, ProxyAgent }        from 'undici';
import type { Response as UndiciResponse } from 'undici';
import type { FetchBackend }  from './FetchBackend.js';
import { FetchRequest }       from './FetchRequest.js';
import { FetchResult }        from './FetchResult.js';
import { SsrfGuard }          from './SsrfGuard.js';
import { SsrfPolicy }         from './SsrfPolicy.js';

/**
 * Default `FetchBackend` implementation using `undici`.
 *
 * **Security model**
 *
 * When `ssrfPolicy` is `BLOCK_PRIVATE`, a custom undici connector is installed
 * that performs DNS resolution and private-range checks inside the TCP connect
 * callback, then forwards the **resolved IP** (not the original hostname) to
 * the underlying socket.  This closes two attack vectors simultaneously:
 *
 * - **Alt-IP bypass** (`127.1`, `0x7f000001`, …): the OS resolver normalises
 *   all IP representations to dotted-decimal before the range check.
 * - **DNS rebinding / TOCTOU**: because the same resolved IP is used for both
 *   the check and the connection, there is no second DNS lookup window in which
 *   an attacker can flip the DNS record to a private address.
 *
 * **Redirect policy**
 *
 * This backend does **not** follow HTTP redirects.  It always returns the raw
 * 3xx response so that `CrawlEngine` can enqueue the `Location` URL through
 * its normal frontier, robots.txt, and rate-limit pipeline.
 *
 * **Body size limit**
 *
 * Reads at most `maxBodyBytes`; sets `bodyTruncated` when the response exceeded
 * the limit.
 *
 * **Keep-alive pool**
 *
 * A single `undici.Agent` is shared across all requests for connection reuse.
 * Call `close()` when the crawl finishes.
 *
 * @example
 * ```ts
 * const backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
 * const result  = await backend.fetch(FetchRequest.get('https://example.com'));
 * console.log(result.statusCode, result.contentType);
 * await backend.close();
 * ```
 */
export class HttpClientBackend implements FetchBackend {
  private readonly agent: Agent | ProxyAgent;
  private readonly ssrfPolicy: SsrfPolicy;
  private closed = false;

  private constructor(
    ssrfPolicy:    SsrfPolicy,
    proxy?:        string,
    agentOptions?: ConstructorParameters<typeof Agent>[0],
  ) {
    this.ssrfPolicy = ssrfPolicy;
    if (proxy) {
      // Route all requests through the provided HTTP proxy.
      // SSRF guard is still enforced per-request in fetch().
      this.agent = new ProxyAgent({
        uri:                 proxy,
        keepAliveTimeout:    30_000,
        keepAliveMaxTimeout: 300_000,
        connections:         64,
      });
    } else {
      this.agent = new Agent({
        keepAliveTimeout:    30_000,
        keepAliveMaxTimeout: 300_000,
        connections:         64,
        // SSRF connector: DNS resolve → range check → connect to resolved IP.
        // Only installed when BLOCK_PRIVATE; ALLOW_ALL uses the default connector.
        ...(ssrfPolicy === SsrfPolicy.BLOCK_PRIVATE
          ? { connect: SsrfGuard.makeConnector(ssrfPolicy) }
          : {}),
        ...agentOptions,
      });
    }
  }

  static create(
    ssrfPolicy: SsrfPolicy = SsrfPolicy.BLOCK_PRIVATE,
    proxy?: string,
  ): HttpClientBackend {
    return new HttpClientBackend(ssrfPolicy, proxy);
  }

  // ── FetchBackend ──────────────────────────────────────────────────────────

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const start = Date.now();
    try {
      return await this.fetchRequest(request, start);
    } catch (err) {
      return FetchResult.fromError(
        request.uri,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.agent.close();
  }

  // ── Single-hop fetch (no redirect following) ──────────────────────────────

  private async fetchRequest(
    request: FetchRequest,
    startMs: number,
  ): Promise<FetchResult> {

    const url = request.uri;

    // ── SSRF pre-flight when routing through a proxy ──────────────────────────
    // When a proxy is configured, the undici connector cannot perform the SSRF
    // check (the TCP connection goes to the proxy, not the target). We do an
    // explicit async DNS check here instead, before handing off to the proxy.
    if (this.agent instanceof ProxyAgent && this.ssrfPolicy !== SsrfPolicy.ALLOW_ALL) {
      await SsrfGuard.check(new URL(url).hostname, this.ssrfPolicy);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method:     request.method,
        headers:    request.headers as Record<string, string>,
        ...(request.body !== undefined && { body: request.body }),
        redirect:   'manual',    // never follow — CrawlEngine handles 3xx
        signal:     controller.signal,
        dispatcher: this.agent,
      });
    } finally {
      clearTimeout(timer);
    }

    // ── Read body with size limit ─────────────────────────────────────────
    // For 3xx responses we still drain the body to free the connection.
    const { body, truncated } = await readBodyWithLimit(response, request.maxBodyBytes);

    // ── Parse headers — null-prototype object prevents __proto__ pollution ─
    const headers = Object.create(null) as Record<string, string[]>;
    response.headers.forEach((value: string, key: string) => {
      const lower = key.toLowerCase();
      if (!headers[lower]) headers[lower] = [];
      headers[lower]!.push(value);
    });

    const { contentType, charset } = parseContentType(
      response.headers.get('content-type') ?? '',
    );

    return FetchResult.builder(request.uri)
      .finalUri(url)
      .statusCode(response.status)
      .statusMessage(response.statusText)
      .responseHeaders(headers)
      .body(body)
      .bodyTruncated(truncated)
      .fetchDurationMs(Date.now() - startMs)
      .redirectChain([])          // no internal redirect following
      .contentType(contentType)
      .charset(charset)
      .build();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Reads the response body up to `maxBytes`. Returns the bytes read and
 * whether the response was truncated.
 */
async function readBodyWithLimit(
  response: UndiciResponse,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (maxBytes === 0 || !response.body) {
    // Drain the body to free the connection even if we don't want the bytes
    if (response.body) await response.body.cancel();
    return { body: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const remaining = maxBytes - total;
      if (value.length >= remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = value.length > remaining;
        await reader.cancel(); // signal we're done reading
        break;
      }

      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return { body, truncated };
}

/**
 * Extracts `contentType` (without params) and `charset` from a
 * `Content-Type` header value like `"text/html; charset=utf-8"`.
 */
function parseContentType(raw: string): { contentType: string; charset: string } {
  const semi = raw.indexOf(';');
  const contentType = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toLowerCase();
  let charset = 'utf-8';

  if (semi >= 0) {
    const params = raw.slice(semi + 1);
    const match = /charset\s*=\s*([^\s;]+)/i.exec(params);
    if (match?.[1]) charset = match[1].toLowerCase().replace(/['"]/g, '');
  }

  return { contentType, charset };
}
