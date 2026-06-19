/**
 * TlsFetchBackend — FetchBackend implementation using got-scraping.
 *
 * got-scraping (by Apify) generates browser-grade HTTP requests:
 *   - Spoofs TLS/JA3 fingerprint to match Chrome
 *   - Sends HTTP/2 frames in browser order
 *   - Generates realistic browser headers (User-Agent, Accept, Sec-Fetch-*, etc.)
 *
 * Sites like Cloudflare identify Node.js/undici by its TLS and HTTP/2 fingerprints
 * and return 403.  got-scraping bypasses this by impersonating Chrome 120.
 *
 * Unlike tls-client (which requires a platform-specific Go binary), got-scraping
 * is a pure-Node package that works on any platform and in any Docker image.
 */

import type { FetchBackend } from '@crawl/engine';
import { FetchResult }       from '@crawl/engine';
import type { FetchRequest } from '@crawl/engine';

// ── got-scraping type shims ───────────────────────────────────────────────────
//
// got-scraping ships with its own types, but we only need a small slice here.
// These are kept minimal and cast-safe so we don't depend on the exact version.

interface GotScrapingOptions {
  url?:            string;
  method?:         string;
  headers?:        Record<string, string>;
  body?:           string;
  timeout?:        { request: number };
  followRedirect?: boolean;
  maxRedirects?:   number;
  throwHttpErrors?: boolean;
  /** Route through an HTTP/HTTPS proxy (e.g. 'http://127.0.0.1:8888') */
  proxyUrl?:       string;
  /** got-scraping specific: controls generated header fingerprint */
  headerGeneratorOptions?: {
    browsers?: Array<{ name: string; minVersion?: number }>;
    operatingSystems?: string[];
    locales?: string[];
  };
}

interface GotScrapingResponse {
  statusCode:    number;
  body:          string;
  headers:       Record<string, string | string[] | undefined>;
  /** Final URL after all redirects */
  url:           string;
  /** List of intermediate URLs followed during redirect resolution */
  redirectUrls?: Array<{ href: string } | string>;
}

type GotScrapingFn = (urlOrOptions: string | GotScrapingOptions, options?: GotScrapingOptions) => Promise<GotScrapingResponse>;

interface GotScrapingModule {
  default?:     GotScrapingFn & { extend?: unknown };
  gotScraping?: GotScrapingFn;
  [key: string]: unknown;
}

// ── Module loading ─────────────────────────────────────────────────────────────

let _gotScraping: GotScrapingFn | null = null;

async function getGotScraping(): Promise<GotScrapingFn> {
  if (_gotScraping) return _gotScraping;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mod = await import('got-scraping') as GotScrapingModule;

    // got-scraping v4 exports `gotScraping` as a named export
    // v3 used a default export.  Handle both.
    const fn =
      (typeof mod['gotScraping'] === 'function' ? mod['gotScraping'] : null) ??
      (typeof mod['default']     === 'function' ? mod['default']     : null);

    if (!fn) throw new Error('got-scraping: could not find callable export');
    _gotScraping = fn as GotScrapingFn;
    return _gotScraping;
  } catch (err) {
    throw new Error(`got-scraping failed to load — is it installed? (${String(err)})`);
  }
}

// ── Helper — normalise headers ────────────────────────────────────────────────

function normaliseHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v : [v];
  }
  return out;
}

// ── Helper — parse Content-Type ───────────────────────────────────────────────

function parseContentType(value: string | undefined): { type: string; charset: string } {
  if (!value) return { type: '', charset: 'utf-8' };
  const parts   = value.split(';').map(s => s.trim());
  const type    = parts[0] ?? '';
  const csParam = parts.find(p => p.toLowerCase().startsWith('charset='));
  const charset = csParam ? csParam.split('=')[1]?.trim() ?? 'utf-8' : 'utf-8';
  return { type, charset };
}

// ── TlsFetchBackend ────────────────────────────────────────────────────────────

/**
 * FetchBackend that uses got-scraping for browser-grade TLS + HTTP/2 fingerprinting.
 *
 * Usage:
 * ```ts
 * const backend = await TlsFetchBackend.create();
 * const result  = await backend.fetch(request);
 * await backend.close(); // no-op
 * ```
 */
import { Security, SsrfGuard, SsrfPolicy } from '@crawl/engine';

/**
 * TlsFetchBackend — FetchBackend implementation using got-scraping.
...
 */
export class TlsFetchBackend implements FetchBackend {
  private readonly ssrfPolicy: SsrfPolicy;
  private readonly proxy: string | undefined;

  constructor(ssrfPolicy: SsrfPolicy = SsrfPolicy.BLOCK_PRIVATE, proxy?: string) {
    this.ssrfPolicy = ssrfPolicy;
    this.proxy = proxy;
  }

  /** Factory — verifies got-scraping loads before returning the backend. */
  static async create(ssrfPolicy: SsrfPolicy = SsrfPolicy.BLOCK_PRIVATE, proxy?: string): Promise<TlsFetchBackend> {
    await getGotScraping();  // throw early if not installed
    return new TlsFetchBackend(ssrfPolicy, proxy);
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const start = Date.now();
    let gotScraping: GotScrapingFn;

    try {
      gotScraping = await getGotScraping();

      // ── SSRF: Pre-flight check ───────────────────────────────────────────
      Security.validateUrl(request.uri);
      await SsrfGuard.check(new URL(request.uri).hostname, this.ssrfPolicy);

    } catch (err) {
      return FetchResult.fromError(
        request.uri,
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    let resp: GotScrapingResponse;
    try {
      resp = await gotScraping(request.uri, {
        method:          request.method,
        ...(request.body !== undefined && { body: request.body }),
        timeout:         { request: request.timeoutMs ?? 10_000 },
        // Security: disabling auto-redirects ensures every hop goes through
        // the engine's frontier/guard pipeline.
        followRedirect:  false,
        maxRedirects:    0,
        throwHttpErrors: false,   // never throw on 4xx/5xx
        ...(this.proxy && { proxyUrl: this.proxy }),
        headerGeneratorOptions: {
          browsers:         [{ name: 'chrome', minVersion: 120 }],
          operatingSystems: ['windows'],
          locales:          ['en-US'],
        },
      });
    } catch (err) {
      return FetchResult.fromError(
        request.uri,
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // ── Build redirect chain ──────────────────────────────────────────────────
    const redirectChain: string[] = (resp.redirectUrls ?? []).map(u =>
      typeof u === 'string' ? u : u.href,
    );

    // ── Build FetchResult ─────────────────────────────────────────────────────
    const normHeaders                   = normaliseHeaders(resp.headers);
    const ct                            = normHeaders['content-type']?.[0] ?? '';
    const { type: contentType, charset } = parseContentType(ct);
    const bodyBytes                     = new TextEncoder().encode(resp.body);
    const maxBytes                      = request.maxBodyBytes ?? Infinity;
    const truncated                     = bodyBytes.byteLength > maxBytes;

    return FetchResult.builder(request.uri)
      .finalUri(resp.url || request.uri)
      .statusCode(resp.statusCode)
      .statusMessage(httpStatusMessage(resp.statusCode))
      .responseHeaders(normHeaders)
      .body(truncated ? bodyBytes.slice(0, maxBytes) : bodyBytes)
      .bodyTruncated(truncated)
      .fetchDurationMs(Date.now() - start)
      .redirectChain(redirectChain)
      .contentType(contentType)
      .charset(charset)
      .build();
  }

  close(): void {
    // got-scraping is stateless — nothing to clean up.
  }
}

// ── Minimal status message map ────────────────────────────────────────────────

function httpStatusMessage(code: number): string {
  const messages: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  return messages[code] ?? '';
}
