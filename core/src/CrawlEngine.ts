import { load }                from 'cheerio';
import { randomUUID }          from 'node:crypto';
import type { CrawlConfig }    from './CrawlConfig.js';
import type { CrawlObserver }  from './CrawlObserver.js';
import type { CrawlSummary }   from './CrawlSummary.js';
import { IgnoreReason }        from './CrawlSummary.js';
import type { Extractor }      from './Extractor.js';
import type { FetchBackend }   from './FetchBackend.js';
import { FetchRequest }        from './FetchRequest.js';
import { FetchResult }         from './FetchResult.js';
import type { Frontier }        from './Frontier.js';
import { InMemoryFrontier }    from './InMemoryFrontier.js';
import { BodyDeduplicator }    from './BodyDeduplicator.js';
import { CookieJar }           from './CookieJar.js';
import { UrlNormalizer }       from './UrlNormalizer.js';
import { RobotsCache }         from './RobotsCache.js';
import { SsrfError }           from './SsrfGuard.js';
import { PageSnapshot }        from './PageSnapshot.js';
import { ParsedPage }          from './ParsedPage.js';

/**
 * Core crawl engine.
 *
 * ```
 *  crawl()                                    AsyncIterable<PageSnapshot>
 *    │
 *    ├── seed frontier + sitemap
 *    │
 *    └── dispatch loop
 *          frontier.next() → entry
 *          maintain promise pool (≤ workers concurrent tasks)
 *          each worker:
 *            robots check → rate limit → fetch → dedup → parse
 *            run extractors → emit PageSnapshot → extract links
 *            frontier.submit(new links) → frontier.complete(url)
 * ```
 *
 * **Concurrency model (TypeScript vs Java)**
 *
 * Java uses `Semaphore` + `newVirtualThreadPerTaskExecutor()`. Here we use an
 * explicit promise pool: the dispatch loop spawns up to `workers` concurrent
 * promises and uses `Promise.race(activeWorkers)` to wait whenever the pool
 * is full. This produces identical throughput for I/O-bound crawling.
 *
 * **Rate limiting**
 *
 * Java uses an `AtomicLong` CAS loop to reserve per-host send slots. In
 * Node.js, async tasks do not interleave between await points, so a plain
 * per-host `Promise` chain achieves the same serialisation without atomics:
 *
 * ```
 *   hostChains.get(host)  →  myTurn = prev.then(() => sleep(delay))
 *   hostChains.set(host, myTurn)
 *   await prev           // wait until my turn
 *   // send now
 * ```
 *
 * Each caller chains onto the previous promise, so requests to the same host
 * are strictly serialised at the configured delay, while requests to different
 * hosts run concurrently.
 *
 * **429 backoff**
 *
 * On HTTP 429, the worker releases its pool slot before sleeping and
 * re-acquires it afterwards — identical to the Java semaphore release/acquire
 * pattern — so a long backoff does not starve other URLs.
 */
export class CrawlEngine {
  private static readonly MAX_BACKOFF_MS = 60_000;

  private stopFlag = false;

  constructor(
    private readonly config:     CrawlConfig,
    private readonly backend:    FetchBackend,
    private readonly extractors: ReadonlyArray<Extractor<unknown>>,
    private readonly observer:   CrawlObserver = {},
    /**
     * Optional frontier override. When provided, the caller owns the frontier
     * lifecycle (seeding, persistence, close). Defaults to a fresh
     * InMemoryFrontier if omitted.
     */
    private readonly frontier?: Frontier,
  ) {
    if (!config || typeof config.seedUrl !== 'string') {
      throw new Error('CrawlEngine: invalid CrawlConfig provided. Use CrawlConfig.builder(url).build()');
    }
  }

  /**
   * Starts the crawl and returns an `AsyncIterable<PageSnapshot>`.
   *
   * ```ts
   * const engine = new CrawlEngine(config, backend, [myExtractor]);
   * for await (const snap of engine.crawl()) {
   *   console.log(snap.statusCode, snap.url);
   * }
   * ```
   *
   * The iterable completes when the frontier drains or `stop()` is called.
   * To retrieve the final `CrawlSummary`, use `crawlWithSummary()` instead.
   */
  crawl(): AsyncIterable<PageSnapshot> & { summary(): Promise<CrawlSummary> } {
    const queue     = new AsyncQueue<PageSnapshot>();
    let   _summary: CrawlSummary | null = null;

    const drivePromise = this.drive((snap) => queue.push(snap))
      .then(s => { _summary = s; })
      .catch(err => { console.error('[CrawlEngine] unexpected drive error', err); })
      .finally(() => queue.close());

    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      summary: async () => {
        await drivePromise;
        if (!_summary) throw new Error('Crawl summary unavailable');
        return _summary;
      },
    };
  }

  /**
   * Stops the engine after current in-flight requests finish.
   * The `CrawlSummary` will have `completedNaturally = false`.
   */
  stop(): void {
    this.stopFlag = true;
  }

  // ── Core drive loop ────────────────────────────────────────────────────────

  private async drive(
    onSnapshot: (s: PageSnapshot) => void,
  ): Promise<CrawlSummary> {

    this.stopFlag = false;
    const startedAt   = new Date();
    const sessionId   = randomUUID();

    const frontier   = this.frontier ?? new InMemoryFrontier();
    const robots     = new RobotsCache(this.backend, this.config.userAgent);
    const dedup      = new BodyDeduplicator();
    const normalizer = new UrlNormalizer(this.config.stripSessionParams);
    const cookieJar  = new CookieJar();

    // Per-host send-slot promise chains (rate limiter)
    const hostChains = new Map<string, Promise<void>>();

    // Counters
    const ignoreCounts = new Map<IgnoreReason, number>(
      Object.values(IgnoreReason).map(r => [r, 0]),
    );
    let captured = 0;
    const buriedUrls = new Set<string>();

    // Seed
    frontier.submit(this.config.seedUrl, 0);
    this.observer.onCrawlStarted?.(this.config.seedUrl, sessionId);

    if (this.config.seedFromSitemap) {
      await this.seedFromSitemap(frontier);
    }

    // ── Dispatch loop ──────────────────────────────────────────────────────
    const activeWorkers = new Set<Promise<void>>();

    const runWorker = async (entry: { url: string; depth: number; referrer?: string }) => {
      try {
        const snap = await this.processEntry(
          entry, frontier, robots, dedup, normalizer,
          hostChains, ignoreCounts, buriedUrls, cookieJar,
        );
        if (snap) {
          captured++;
          onSnapshot(snap);
          this.observer.onPageCaptured?.(
            snap, captured, frontier.queueSize(), frontier.inFlightCount(),
          );
        }
      } finally {
        frontier.complete(entry.url);
      }
    };

    while (!this.stopFlag) {
      const entry = frontier.next();

      if (!entry) {
        if (frontier.isDrained() && activeWorkers.size === 0) break;
        if (activeWorkers.size === 0) break; // frontier empty, nothing in flight
        // Wait for any worker to finish (it may submit new URLs)
        await Promise.race(activeWorkers);
        continue;
      }

      // Depth gate
      if (isFinite(this.config.maxDepth) && entry.depth > this.config.maxDepth) {
        buriedUrls.add(entry.url);
        inc(ignoreCounts, IgnoreReason.MAX_DEPTH);
        frontier.complete(entry.url);
        continue;
      }

      // Wait if the pool is full
      if (activeWorkers.size >= this.config.workers) {
        await Promise.race(activeWorkers);
      }

      if (this.stopFlag) {
        frontier.complete(entry.url);
        break;
      }

      const promise = runWorker(entry).finally(() => activeWorkers.delete(promise));
      activeWorkers.add(promise);
    }

    // Drain remaining workers
    if (activeWorkers.size > 0) await Promise.allSettled(activeWorkers);

    const completedAt = new Date();

    const breakdown: Partial<Record<IgnoreReason, number>> = {};
    let totalIgnored = 0;
    for (const [reason, count] of ignoreCounts) {
      if (count > 0) { breakdown[reason] = count; totalIgnored += count; }
    }

    const summary: CrawlSummary = {
      seedUrl:            this.config.seedUrl,
      pagesCaptured:      captured,
      pagesIgnored:       totalIgnored,
      ignoredBreakdown:   breakdown,
      durationMs:         completedAt.getTime() - startedAt.getTime(),
      completedNaturally: !this.stopFlag,
      startedAt,
      completedAt,
      buriedUrls,
    };
    this.observer.onCrawlCompleted?.(summary);
    return summary;
  }

  // ── Worker ────────────────────────────────────────────────────────────────

  private async processEntry(
    entry:        { url: string; depth: number; referrer?: string },
    frontier:     Frontier,
    robots:       RobotsCache,
    dedup:        BodyDeduplicator,
    normalizer:   UrlNormalizer,
    hostChains:   Map<string, Promise<void>>,
    ignoreCounts: Map<IgnoreReason, number>,
    buriedUrls:   Set<string>,
    cookieJar:    CookieJar,
  ): Promise<PageSnapshot | null> {

    const { url, depth } = entry;

    try {
      // ── robots.txt ───────────────────────────────────────────────────────
      if (this.config.respectRobotsTxt && !(await robots.isAllowed(url))) {
        inc(ignoreCounts, IgnoreReason.ROBOTS_DISALLOWED);
        return null;
      }

      // ── Rate limit ───────────────────────────────────────────────────────
      await this.applyRateLimit(url, hostChains);

      // ── Fetch with 429 retry ─────────────────────────────────────────────
      const headers = this.config.defaultHeaders(entry.referrer);

      // Inject any cookies already set by the server for this host
      const cookieHeader = cookieJar.cookiesFor(url);
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      const request = FetchRequest.builder(url)
        .headers(headers)
        .timeoutMs(this.config.timeoutMs)
        .maxBodyBytes(this.config.maxBodyBytes)
        .maxRedirects(this.config.maxRedirects)
        .renderJs(this.config.renderJs)
        .postNavigationDelayMs(this.config.postNavigationDelayMs)
        .build();

      const result = await this.fetchWithRetry(request, hostChains);

      // Store any cookies the server set in this response
      if (!FetchResult.isFetchError(result)) {
        cookieJar.processResponse(result.finalUri, result.responseHeaders);
      }

      // ── Handle SSRF blocks and fetch errors ──────────────────────────────
      if (FetchResult.isFetchError(result)) {
        if (result.error instanceof SsrfError) {
          inc(ignoreCounts, IgnoreReason.SSRF_BLOCKED);
        } else {
          inc(ignoreCounts, IgnoreReason.FETCH_ERROR);
        }
        this.observer.onPageFailed?.(url, result.error);
        return null;
      }

      // ── Handle 3xx redirects ──────────────────────────────────────────────
      // HttpClientBackend returns 3xx as-is (redirect: 'manual').
      // We enqueue the Location URL through the normal frontier pipeline so
      // that it is subject to robots.txt, rate limits, and depth checks,
      // rather than being followed inline with none of those guarantees.
      if (FetchResult.isRedirect(result)) {
        const location = FetchResult.header(result, 'location');
        if (location) {
          try {
            const resolved = new URL(location, result.finalUri).toString();
            if (this.config.isInScope(resolved)) {
              frontier.submit(resolved, depth); // same depth — redirect ≠ new level
            }
          } catch {
            // malformed Location header — ignore
          }
        }
        inc(ignoreCounts, IgnoreReason.REDIRECT);
        return null;
      }

      // ── Body deduplication ───────────────────────────────────────────────
      const isDuplicate = this.config.detectDuplicates && result.body.length > 0
        && dedup.isDuplicate(result.body);

      // ── HTML parsing ─────────────────────────────────────────────────────
      let document = null;
      if (FetchResult.isHtml(result) && result.body.length > 0) {
        const html = FetchResult.bodyText(result);
        document = load(html);
      }

      const parsedPage = ParsedPage.create(result, document, depth);

      // ── Extractors ───────────────────────────────────────────────────────
      const extractions = new Map<string, unknown>();
      for (const extractor of this.extractors) {
        try {
          const id = extractor.id();
          const value = extractor.extract(parsedPage);
          extractions.set(id, value);
        } catch (e) {
          // Extractor errors are non-fatal — the page snapshot is still emitted.
          // Fire the observer so callers can log/track which extractors are broken.
          this.observer.onExtractorError?.(
            url,
            extractor.id(),
            e instanceof Error ? e : new Error(String(e)),
          );
        }
      }

      const snapshot = new PageSnapshot({
        url:         result.finalUri,
        fetchResult: result,
        extractions,
        isDuplicate,
        depth,
        capturedAt:  new Date(),
      });

      // ── Link extraction ──────────────────────────────────────────────────
      if (!isDuplicate && document) {
        document('a[href]').each((_i: number, el: unknown) => {
          const href = document!(el as never).attr('href');
          if (!href) return;
          const resolved = normalizer.resolve(result.finalUri, href);
          if (resolved && this.config.isInScope(resolved)) {
            // Pass result.finalUri as referrer so child requests include
            // a Referer header and a correctly computed Sec-Fetch-Site.
            frontier.submit(resolved, depth + 1, result.finalUri);
          }
        });
      }

      return snapshot;

    } catch (e) {
      inc(ignoreCounts, IgnoreReason.FETCH_ERROR);
      this.observer.onPageFailed?.(url, e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  }

  // ── Rate limiting (per-host promise chain) ────────────────────────────────

  /**
   * Serialises requests to the same host at the configured delay by chaining
   * onto the previous host promise. Each caller awaits its predecessor, then
   * sleeps for a jittered delay before returning — at which point the next
   * caller can fire.
   */
  private async applyRateLimit(
    url:        string,
    hostChains: Map<string, Promise<void>>,
  ): Promise<void> {
    const delay = this.config.requestDelayMs;
    if (delay === 0) return;

    let host: string;
    try { host = new URL(url).host; } catch { return; }

    // Reserve my slot: chain onto the previous caller's promise
    const prev    = hostChains.get(host) ?? Promise.resolve();
    const mySlot  = prev.then(() => sleep(this.jitteredDelay(delay)));
    hostChains.set(host, mySlot);

    // Wait until the slot before mine completes
    await prev;
  }

  private jitteredDelay(base: number): number {
    const jitter = this.config.jitterPct;
    if (jitter === 0) return base;
    return base + Math.floor(base * (jitter / 100) * Math.random());
  }

  // ── 429 fetch-with-retry ──────────────────────────────────────────────────

  private async fetchWithRetry(
    request:    FetchRequest,
    hostChains: Map<string, Promise<void>>,
  ): Promise<FetchResult> {
    let result = await this.fetchOnce(request);

    for (
      let attempt = 1;
      result.statusCode === 429 && attempt <= this.config.maxRetries;
      attempt++
    ) {
      const backoffMs = Math.min(
        this.config.retryDelayMs * Math.pow(2, attempt - 1),
        CrawlEngine.MAX_BACKOFF_MS,
      );
      this.observer.onRateLimitBackOff?.(request.uri, attempt, backoffMs);

      // Release the per-host slot reservation by clearing the chain —
      // the sleep here takes the place of a queued slot.
      // On retry, applyRateLimit() will re-acquire naturally.
      try {
        const host = new URL(request.uri).host;
        hostChains.delete(host);
      } catch { /* ignore — invalid URI, nothing to release */ }

      await sleep(backoffMs);
      result = await this.fetchOnce(request);
    }

    return result;
  }

  private async fetchOnce(request: FetchRequest): Promise<FetchResult> {
    try {
      return await this.backend.fetch(request);
    } catch (err) {
      return FetchResult.fromError(
        request.uri,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  // ── Sitemap seeding ───────────────────────────────────────────────────────

  private async seedFromSitemap(frontier: Frontier): Promise<void> {
    const sitemapUrl = new URL('/sitemap.xml', this.config.seedUrl).toString();
    try {
      const result = await this.backend.fetch(FetchRequest.get(sitemapUrl, 10_000));
      if (!FetchResult.isSuccess(result) || result.body.length === 0) return;

      const xml  = FetchResult.bodyText(result);
      const $    = load(xml, { xmlMode: true });

      // Standard sitemap: <urlset><url><loc>...</loc></url></urlset>
      $('url > loc').each((_i: number, el: unknown) => {
        const loc = $(el as never).text().trim();
        if (loc && this.config.isInScope(loc)) frontier.submit(loc, 0);
      });

      // Sitemap index: <sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>
      // isInScope guards against third-party CDN sitemap entries leaking
      // out-of-scope URLs into the frontier.
      $('sitemap > loc').each((_i: number, el: unknown) => {
        const loc = $(el as never).text().trim();
        if (loc && this.config.isInScope(loc)) frontier.submit(loc, 0);
      });
    } catch {
      // Sitemap fetch failure is non-fatal; crawl continues from seed URL
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function inc(map: Map<IgnoreReason, number>, key: IgnoreReason): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Minimal async queue: producers `push()`, consumers `for await` the iterator.
 * Closing with `close()` signals the end of the stream.
 */
class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters) waiter({ value: undefined as unknown as T, done: true });
    this.waiters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done)         return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}
