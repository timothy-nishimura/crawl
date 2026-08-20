import { lookup } from 'node:dns';
import type { FetchBackend, FetchRequest, CookieJar } from '@crawl/engine';
import { FetchResult, Security, SsrfGuard, SsrfPolicy } from '@crawl/engine';

interface GotScrapingOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: { request: number };
  followRedirect?: boolean;
  maxRedirects?: number;
  throwHttpErrors?: boolean;
  proxyUrl?: string;
  dnsLookup?: (hostname: string, options: object, callback: (err: Error | null, address: string, family: number) => void) => void;
  headerGeneratorOptions?: {
    browsers?: Array<{ name: string; minVersion?: number }>;
    operatingSystems?: string[];
    locales?: string[];
  };
}

interface GotScrapingResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  redirectUrls?: Array<{ href: string } | string>;
}

type GotScrapingFn = (urlOrOptions: string | GotScrapingOptions, options?: GotScrapingOptions) => Promise<GotScrapingResponse>;

let _gotScraping: GotScrapingFn | null = null;

async function getGotScraping(): Promise<GotScrapingFn> {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping') as { default?: GotScrapingFn; gotScraping?: GotScrapingFn };
    const fn = (typeof mod.gotScraping === 'function' ? mod.gotScraping : null) ??
               (typeof mod.default === 'function' ? mod.default : null);
    if (!fn) throw new Error('got-scraping export not found');
    _gotScraping = fn;
    return _gotScraping;
  } catch (err) {
    throw new Error(`Failed to load got-scraping: ${String(err)}`);
  }
}

function normaliseHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v : [v];
  }
  return out;
}

function parseContentType(value: string | undefined): { type: string; charset: string } {
  if (!value) return { type: '', charset: 'utf-8' };
  const parts = value.split(';').map(s => s.trim());
  const type = parts[0] ?? '';
  const csParam = parts.find(p => p.toLowerCase().startsWith('charset='));
  const charset = csParam ? csParam.split('=')[1]?.trim() ?? 'utf-8' : 'utf-8';
  return { type, charset };
}

function createSsrfLookup(policy: SsrfPolicy) {
  return (hostname: string, _options: object, callback: (err: Error | null, address: string, family: number) => void) => {
    if (policy === SsrfPolicy.ALLOW_ALL) {
      lookup(hostname, callback);
      return;
    }
    lookup(hostname, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      try {
        SsrfGuard.checkIp(address, policy, hostname);
        callback(null, address, family);
      } catch (checkErr) {
        callback(checkErr instanceof Error ? checkErr : new Error(String(checkErr)), address, family);
      }
    });
  };
}

export class TlsFetchBackend implements FetchBackend {
  private readonly ssrfPolicy: SsrfPolicy;
  private readonly proxy?: string;
  private readonly cookieJar?: CookieJar;

  constructor(ssrfPolicy: SsrfPolicy = SsrfPolicy.BLOCK_PRIVATE, proxy?: string, cookieJar?: CookieJar) {
    this.ssrfPolicy = ssrfPolicy;
    this.proxy = proxy;
    this.cookieJar = cookieJar;
  }

  static async create(ssrfPolicy: SsrfPolicy = SsrfPolicy.BLOCK_PRIVATE, proxy?: string, cookieJar?: CookieJar): Promise<TlsFetchBackend> {
    await getGotScraping();
    return new TlsFetchBackend(ssrfPolicy, proxy, cookieJar);
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const start = Date.now();
    let gotScraping: GotScrapingFn;

    try {
      gotScraping = await getGotScraping();
      Security.validateUrl(request.uri);
      await SsrfGuard.check(new URL(request.uri).hostname, this.ssrfPolicy);
    } catch (err) {
      return FetchResult.fromError(request.uri, err instanceof Error ? err : new Error(String(err)));
    }

    const headers: Record<string, string> = { ...request.headers };
    if (this.cookieJar) {
      const cookieHeader = this.cookieJar.cookiesFor(request.uri);
      if (cookieHeader) headers['cookie'] = cookieHeader;
    }

    let resp: GotScrapingResponse;
    try {
      resp = await gotScraping(request.uri, {
        method: request.method,
        headers,
        ...(request.body !== undefined && { body: request.body }),
        timeout: { request: request.timeoutMs ?? 10_000 },
        followRedirect: false,
        maxRedirects: 0,
        throwHttpErrors: false,
        dnsLookup: createSsrfLookup(this.ssrfPolicy),
        ...(this.proxy && { proxyUrl: this.proxy }),
        headerGeneratorOptions: {
          browsers: [{ name: 'chrome', minVersion: 120 }],
          operatingSystems: ['windows'],
          locales: ['en-US'],
        },
      });
    } catch (err) {
      return FetchResult.fromError(request.uri, err instanceof Error ? err : new Error(String(err)));
    }

    const normHeaders = normaliseHeaders(resp.headers);
    if (this.cookieJar) {
      this.cookieJar.processResponse(request.uri, normHeaders);
    }

    const redirectChain: string[] = (resp.redirectUrls ?? []).map(u => (typeof u === 'string' ? u : u.href));
    const ct = normHeaders['content-type']?.[0] ?? '';
    const { type: contentType, charset } = parseContentType(ct);
    const bodyBytes = new TextEncoder().encode(resp.body);
    const maxBytes = request.maxBodyBytes ?? Infinity;
    const truncated = bodyBytes.byteLength > maxBytes;

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

  close(): void {}
}

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
