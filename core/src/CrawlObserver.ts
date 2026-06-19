import type { PageSnapshot } from './PageSnapshot.js';
import type { CrawlSummary }  from './CrawlSummary.js';

/**
 * Push-style lifecycle callbacks for a crawl run.
 *
 * All methods are optional — extend `CrawlObserver.Adapter` to implement
 * only what you need.
 *
 * Methods are called from async worker tasks and must not throw.
 */
export interface CrawlObserver {
  onCrawlStarted?(seedUrl: string, sessionId: string): void;
  onCrawlCompleted?(summary: CrawlSummary): void;
  onPageCaptured?(
    snapshot: PageSnapshot,
    captured: number,
    queueSize: number,
    inFlight: number,
  ): void;
  onPageFailed?(url: string, error: Error | null): void;
  onRateLimitBackOff?(url: string, attempt: number, delayMs: number): void;
  /**
   * Fired when an extractor throws during `extract()`. The error is non-fatal
   * and the page snapshot is still emitted — the extractor's slot is simply
   * absent from the extraction map.
   */
  onExtractorError?(url: string, extractorId: string, error: Error): void;
}

export namespace CrawlObserver {
  /**
   * No-op base class. Extend and override only the callbacks you need.
   *
   * All methods from `CrawlObserver` are optional, so this empty class
   * satisfies the interface — subclasses add only what they care about.
   */
  export class Adapter implements CrawlObserver {}

  /** A console-logging observer useful for development. */
  export function consolePrinter(): CrawlObserver {
    return {
      onCrawlStarted: (seed) => console.log(`[crawl] started  seed=${seed}`),
      onCrawlCompleted: (s) =>
        console.log(`[crawl] done  captured=${s.pagesCaptured}  ignored=${s.pagesIgnored}  ` +
                    `dur=${s.durationMs}ms`),
      onPageFailed: (url, err) =>
        console.warn(`[crawl] failed  url=${url}  err=${err?.message ?? 'unknown'}`),
      onRateLimitBackOff: (url, attempt, ms) =>
        console.warn(`[crawl] 429  url=${url}  attempt=${attempt}  backoff=${ms}ms`),
    };
  }
}
