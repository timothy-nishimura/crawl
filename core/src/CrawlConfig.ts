import { SsrfPolicy } from './SsrfPolicy.js';

/**
 * Immutable configuration for a single crawl session.
 *
 * Construct via `CrawlConfig.builder(seedUrl)`. All validation
 * happens at `build()` time — never silently at crawl time.
 *
 * @example
 * ```ts
 * const config = CrawlConfig.builder('https://example.com')
 *   .maxDepth(3)
 *   .workers(8)
 *   .includePattern('/blog/')
 *   .build();
 * ```
 */
export class CrawlConfig {
  // ── Scope ──────────────────────────────────────────────────────────────────
  readonly seedUrl:          string;
  readonly domain:           string;
  readonly maxDepth:         number;
  readonly crawlSubdomains:  boolean;
  readonly includePatterns:  readonly string[];
  readonly excludePatterns:  readonly string[];
  // ── Concurrency ────────────────────────────────────────────────────────────
  readonly workers: number;

  // ── HTTP / transport ───────────────────────────────────────────────────────
  readonly timeoutMs:      number;
  readonly maxBodyBytes:   number;
  readonly maxRedirects:   number;
  readonly userAgent:      string;
  readonly renderJs:       boolean;

  // ── Traffic shaping ────────────────────────────────────────────────────────
  readonly requestDelayMs: number;
  readonly jitterPct:      number;
  readonly retryDelayMs:   number;
  readonly maxRetries:     number;
  readonly postNavigationDelayMs: number;

  // ── Web standards ──────────────────────────────────────────────────────────
  readonly respectRobotsTxt:  boolean;
  readonly seedFromSitemap:   boolean;
  readonly detectDuplicates:  boolean;
  readonly stripSessionParams: boolean;

  // ── Security ───────────────────────────────────────────────────────────────
  readonly ssrfPolicy: SsrfPolicy;

  /**
   * @internal — use {@link CrawlConfig.builder} to construct instances.
   */
  constructor(b: CrawlConfig.Builder) {
    this.seedUrl           = b._seedUrl;
    this.domain            = b._domain;
    this.maxDepth          = b._maxDepth;
    this.crawlSubdomains   = b._crawlSubdomains;
    this.includePatterns   = Object.freeze([...b._includePatterns]);
    this.excludePatterns   = Object.freeze([...b._excludePatterns]);
    this.workers           = b._workers;
    this.timeoutMs         = b._timeoutMs;
    this.maxBodyBytes      = b._maxBodyBytes;
    this.maxRedirects      = b._maxRedirects;
    this.userAgent         = b._userAgent;
    this.requestDelayMs    = b._requestDelayMs;
    this.jitterPct         = b._jitterPct;
    this.retryDelayMs      = b._retryDelayMs;
    this.maxRetries        = b._maxRetries;
    this.respectRobotsTxt  = b._respectRobotsTxt;
    this.seedFromSitemap   = b._seedFromSitemap;
    this.detectDuplicates  = b._detectDuplicates;
    this.stripSessionParams = b._stripSessionParams;
    this.ssrfPolicy        = b._ssrfPolicy;
    this.renderJs          = b._renderJs;
    this.postNavigationDelayMs = b._postNavigationDelayMs;
    Object.freeze(this);
  }

  // ── Request helpers ────────────────────────────────────────────────────────

  /**
   * Returns a Chrome-compatible header set for every outbound request.
   *
   * Includes the configured user-agent plus the Sec-Fetch-*, Sec-CH-UA-*,
   * Accept, Accept-Language, Cache-Control, and Upgrade-Insecure-Requests
   * headers that real Chrome sends. Bot detection systems (Akamai, Datadome,
   * PerimeterX) score heavily on missing Sec-Fetch-* headers.
   *
   * Note: Accept-Encoding is intentionally omitted — undici's fetch API
   * negotiates and decompresses gzip/br transparently.
   *
   * @param referrer - Optional URL of the page that linked to this request.
   *   When provided, a `Referer` header is included and `Sec-Fetch-Site` is
   *   computed from the relationship between the two origins.
   */
  defaultHeaders(referrer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent':                this.userAgent,
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language':           'en-US,en;q=0.9',
      'Cache-Control':             'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            CrawlConfig.secFetchSite(this.seedUrl, referrer),
      'Sec-Fetch-User':            '?1',
      'Sec-CH-UA':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-CH-UA-Mobile':          '?0',
      'Sec-CH-UA-Platform':        '"Windows"',
    };
    if (referrer) headers['Referer'] = referrer;
    return headers;
  }

  /**
   * Computes the `Sec-Fetch-Site` value from the relationship between
   * the request URL and the referrer URL.
   *
   * - `none`        — no referrer (direct navigation / seed page)
   * - `same-origin` — same scheme + host + port
   * - `same-site`   — same registrable domain, different subdomain
   * - `cross-site`  — different registrable domain
   */
  static secFetchSite(requestUrl: string, referrer: string | undefined): string {
    if (!referrer) return 'none';
    try {
      const req = new URL(requestUrl);
      const ref = new URL(referrer);
      if (req.origin === ref.origin) return 'same-origin';
      const reqReg = req.hostname.split('.').slice(-2).join('.');
      const refReg = ref.hostname.split('.').slice(-2).join('.');
      if (reqReg === refReg) return 'same-site';
      return 'cross-site';
    } catch {
      return 'same-origin';
    }
  }

  // ── Scope helpers ──────────────────────────────────────────────────────────

  /**
   * Returns `true` if `url` is in crawl scope: passes include/exclude
   * pattern checks and belongs to the configured domain.
   */
  isInScope(url: string): boolean {
    if (!url) return false;

    for (const pat of this.excludePatterns) {
      if (url.includes(pat)) return false;
    }

    if (this.includePatterns.length > 0) {
      if (!this.includePatterns.some(pat => url.includes(pat))) return false;
    }

    return this.isInternalLink(url);
  }

  /** Returns `true` if `url` belongs to the configured domain (and optionally subdomains). */
  isInternalLink(url: string): boolean {
    try {
      let host = new URL(url).hostname.toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);
      return this.crawlSubdomains
        ? host === this.domain || host.endsWith(`.${this.domain}`)
        : host === this.domain;
    } catch {
      return false;
    }
  }

  static builder(seedUrl: string): CrawlConfig.Builder {
    return new CrawlConfig.Builder(seedUrl);
  }
}

// ── Companion namespace (merges with the class above) ─────────────────────────
// This gives `CrawlConfig.Builder` a proper type that TypeScript recognises in
// both value position (`new CrawlConfig.Builder(...)`) and type position
// (`: CrawlConfig.Builder`).

export namespace CrawlConfig {
  export class Builder {
    /** @internal */ _seedUrl:            string;
    /** @internal */ _domain:             string;
    /** @internal */ _maxDepth            = Infinity;
    /** @internal */ _crawlSubdomains     = false;
    /** @internal */ _includePatterns:    string[] = [];
    /** @internal */ _excludePatterns:    string[] = [];
    /** @internal */ _workers             = 4;
    /** @internal */ _timeoutMs           = 10_000;
    /** @internal */ _maxBodyBytes        = 5 * 1024 * 1024;
    /** @internal */ _maxRedirects        = 10;
    /** @internal */ _userAgent           =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36';
    /** @internal */ _requestDelayMs      = 500;
    /** @internal */ _jitterPct           = 20;
    /** @internal */ _retryDelayMs        = 2_000;
    /** @internal */ _maxRetries          = 5;
    /** @internal */ _respectRobotsTxt    = true;
    /** @internal */ _seedFromSitemap     = true;
    /** @internal */ _detectDuplicates    = true;
    /** @internal */ _stripSessionParams  = true;
    /** @internal */ _ssrfPolicy          = SsrfPolicy.BLOCK_PRIVATE;
    /** @internal */ _renderJs            = false;
    /** @internal */ _postNavigationDelayMs = 0;

    constructor(seedUrl: string) {
      if (!seedUrl) throw new Error('seedUrl must not be blank');
      const trimmed = seedUrl.trim();
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        throw new Error(`seedUrl must begin with http:// or https://, got: ${trimmed}`);
      }
      let host: string;
      try {
        host = new URL(trimmed).hostname;
      } catch (e) {
        throw new Error(`seedUrl is not a valid URL: ${trimmed}`);
      }
      if (!host) throw new Error(`seedUrl has no host: ${trimmed}`);
      this._seedUrl = trimmed;
      this._domain  = host.startsWith('www.') ? host.slice(4) : host;
    }

    maxDepth(n: number):            this { this._maxDepth = n;            return this; }
    crawlSubdomains(v: boolean):    this { this._crawlSubdomains = v;    return this; }
    includePattern(p: string):      this { this._includePatterns.push(p); return this; }
    excludePattern(p: string):      this { this._excludePatterns.push(p); return this; }
    workers(n: number):             this { this._workers = n;            return this; }
    timeoutMs(ms: number):          this { this._timeoutMs = ms;         return this; }
    maxBodyBytes(n: number):        this { this._maxBodyBytes = n;       return this; }
    maxRedirects(n: number):        this { this._maxRedirects = n;       return this; }
    userAgent(ua: string):          this { this._userAgent = ua;         return this; }
    requestDelayMs(ms: number):     this { this._requestDelayMs = ms;    return this; }
    jitterPct(pct: number):         this { this._jitterPct = pct;        return this; }
    retryDelayMs(ms: number):       this { this._retryDelayMs = ms;      return this; }
    maxRetries(n: number):          this { this._maxRetries = n;         return this; }
    respectRobotsTxt(v: boolean):   this { this._respectRobotsTxt = v;  return this; }
    seedFromSitemap(v: boolean):    this { this._seedFromSitemap = v;    return this; }
    detectDuplicates(v: boolean):   this { this._detectDuplicates = v;  return this; }
    stripSessionParams(v: boolean): this { this._stripSessionParams = v; return this; }
    ssrfPolicy(p: SsrfPolicy):      this { this._ssrfPolicy = p;         return this; }
    renderJs(v: boolean):           this { this._renderJs = v;           return this; }
    postNavigationDelayMs(ms: number): this { this._postNavigationDelayMs = ms; return this; }

    build(): CrawlConfig {
      if (this._workers < 1)
        throw new Error(`workers must be >= 1, got ${this._workers}`);
      if (this._jitterPct < 0 || this._jitterPct > 100)
        throw new Error(`jitterPct must be 0–100, got ${this._jitterPct}`);
      if (this._maxRetries < 0)
        throw new Error(`maxRetries must be >= 0, got ${this._maxRetries}`);
      if (this._maxBodyBytes <= 0)
        throw new Error(`maxBodyBytes must be > 0, got ${this._maxBodyBytes}`);

      const inclSet = new Set(this._includePatterns);
      for (const excl of this._excludePatterns) {
        if (inclSet.has(excl))
          throw new Error(`Pattern appears in both include and exclude lists: "${excl}"`);
      }

      return new CrawlConfig(this);
    }
  }
}
