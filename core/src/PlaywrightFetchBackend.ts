import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { FetchBackend } from './FetchBackend.js';
import { FetchRequest } from './FetchRequest.js';
import { FetchResult } from './FetchResult.js';
import { Security } from './Security.js';
import { SsrfGuard } from './SsrfGuard.js';
import { SsrfPolicy } from './SsrfPolicy.js';

/**
 * A FetchBackend that uses a headless browser (Playwright) to render pages.
 * Essential for Single Page Applications (SPAs) and JS-heavy sites.
 */
export class PlaywrightFetchBackend implements FetchBackend {
  private browser: Browser | null = null;
  private readonly ssrfPolicy: SsrfPolicy;

  constructor(private readonly options: {
    headless?: boolean;
    timeoutMs?: number;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    postNavigationDelayMs?: number;
    ssrfPolicy?: SsrfPolicy;
    /** HTTP/HTTPS proxy URL (e.g. http://127.0.0.1:8888). Routes all browser traffic through the proxy. */
    proxy?: string;
  } = {}) {
    this.ssrfPolicy = options.ssrfPolicy ?? SsrfPolicy.BLOCK_PRIVATE;
  }

  /**
   * Static factory to ensure the browser is launched.
   */
  static async create(options: ConstructorParameters<typeof PlaywrightFetchBackend>[0] = {}): Promise<PlaywrightFetchBackend> {
    const backend = new PlaywrightFetchBackend(options);
    await backend.init();
    return backend;
  }

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ 
        headless: this.options.headless !== false 
      });
    }
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    if (!this.browser) await this.init();
    
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const startTime = Date.now();

    try {
      // ── SSRF: Pre-flight check on target URL ─────────────────────────────
      Security.validateUrl(request.uri);
      await SsrfGuard.check(new URL(request.uri).hostname, this.ssrfPolicy);

      context = await this.browser!.newContext({
        userAgent: request.headers['User-Agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
        ...(this.options.proxy && { proxy: { server: this.options.proxy } }),
      });

      page = await context.newPage();

      // ── SSRF: Intercept ALL outgoing requests (main + sub-resources) ─────
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        try {
          Security.validateUrl(url);
          const u = new URL(url);
          await SsrfGuard.check(u.hostname, this.ssrfPolicy);
          await route.continue();
        } catch (err) {
          console.warn(`[Playwright-SSRF] Blocking ${url}: ${err instanceof Error ? err.message : String(err)}`);
          await route.abort('blockedbyclient');
        }
      });

      // Optimize: Block heavy resources but ALLOW CSS (needed for hydration in some SPAs)
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf}', route => route.abort());

      const response = await page.goto(request.uri, {
        timeout: this.options.timeoutMs ?? request.timeoutMs ?? 30000,
        waitUntil: this.options.waitUntil ?? 'domcontentloaded',
      });

      const delay = request.postNavigationDelayMs ?? this.options.postNavigationDelayMs;
      if (delay) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      if (!response) {
        return FetchResult.fromError(request.uri, new Error('Playwright failed to get a response'));
      }

      const status = response.status();
      const content = await page.content();
      const body = new TextEncoder().encode(content);

      // Map headers (Playwright returns Record<string, string>, core expects Record<string, string[]>)
      const headers: Record<string, string[]> = {};
      const respHeaders = response.headers();
      for (const [key, value] of Object.entries(respHeaders)) {
        headers[key.toLowerCase()] = [value];
      }

      return FetchResult.builder(request.uri)
        .finalUri(page.url())
        .statusCode(status)
        .responseHeaders(headers)
        .body(body)
        .contentType(headers['content-type']?.[0] || 'text/html')
        .fetchDurationMs(Date.now() - startTime)
        .build();

    } catch (err) {
      console.error(`[Playwright] Error fetching ${request.uri}:`, err);
      return FetchResult.fromError(request.uri, err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
