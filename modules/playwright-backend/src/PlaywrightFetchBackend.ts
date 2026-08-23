import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  FetchRequest,
  FetchResult,
  SsrfGuard,
  SsrfPolicy,
  type FetchBackend,
} from '@crawl/engine';

/**
 * A FetchBackend that uses a headless browser (Playwright) to render pages.
 * Useful for SPAs or JS-heavy applications where HttpClientBackend only gets empty shells.
 */
export class PlaywrightFetchBackend implements FetchBackend {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly headless: boolean;
  private readonly ssrfPolicy: SsrfPolicy;
  private readonly proxy?: string;

  constructor(options: {
    headless?: boolean;
    ssrfPolicy?: SsrfPolicy;
    proxy?: string;
  } = {}) {
    this.headless = options.headless ?? true;
    this.ssrfPolicy = options.ssrfPolicy ?? SsrfPolicy.BLOCK_PRIVATE;
    this.proxy = options.proxy;
  }

  static async create(options: ConstructorParameters<typeof PlaywrightFetchBackend>[0] = {}): Promise<PlaywrightFetchBackend> {
    const backend = new PlaywrightFetchBackend(options);
    await backend.init();
    return backend;
  }

  private async init(): Promise<void> {
    if (!this.browser) {
      const launchOptions: Parameters<typeof chromium.launch>[0] = {
        headless: this.headless,
      };

      if (this.proxy) {
        launchOptions.proxy = { server: this.proxy };
      }

      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        ignoreHTTPSErrors: true,
      });
    }
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const start = Date.now();
    await this.init();

    let page: Page | null = null;
    try {
      // 1. SSRF check before opening the browser to the URL
      await SsrfGuard.check(request.uri, this.ssrfPolicy);

      page = await this.context!.newPage();

      // Set timeout
      page.setDefaultTimeout(request.timeoutMs);
      page.setDefaultNavigationTimeout(request.timeoutMs);

      // Set headers
      if (Object.keys(request.headers).length > 0) {
        const flatHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.headers)) {
          flatHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        await page.setExtraHTTPHeaders(flatHeaders);
      }

      // Route-level SSRF interception: block internal resources requested by the page
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        try {
          await SsrfGuard.check(url, this.ssrfPolicy);
          await route.continue();
        } catch (err) {
          console.warn(`[Playwright-SSRF] Blocking ${url}: ${err instanceof Error ? err.message : String(err)}`);
          await route.abort();
        }
      });

      // 2. Navigate
      const response = await page.goto(request.uri, {
        waitUntil: 'networkidle',
      });

      // Optional post-navigation delay
      if (request.postNavigationDelayMs && request.postNavigationDelayMs > 0) {
        await page.waitForTimeout(request.postNavigationDelayMs);
      }

      if (!response) {
        return FetchResult.fromError(request.uri, new Error('Playwright failed to get a response'));
      }

      // 3. Extract content & headers
      const content = await page.content();
      const status = response.status();
      const rawHeaders = await response.allHeaders();

      // Map headers (Playwright returns Record<string, string>, core expects Record<string, string[]>)
      const headers: Record<string, string[]> = {};
      for (const [key, val] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = [val];
      }

      const bodyBuffer = Buffer.from(content, 'utf-8');

      return FetchResult.builder(request.uri)
        .finalUri(page.url() || request.uri)
        .statusCode(status)
        .responseHeaders(headers)
        .body(bodyBuffer)
        .fetchDurationMs(Date.now() - start)
        .contentType('text/html')
        .build();
    } catch (err) {
      console.error(`[Playwright] Error fetching ${request.uri}:`, err);
      return FetchResult.fromError(
        request.uri,
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
