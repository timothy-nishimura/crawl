/**
 * Reasons a URL was skipped without being captured.
 */
export enum IgnoreReason {
  MAX_DEPTH         = 'MAX_DEPTH',
  ROBOTS_DISALLOWED = 'ROBOTS_DISALLOWED',
  SSRF_BLOCKED      = 'SSRF_BLOCKED',
  FETCH_ERROR       = 'FETCH_ERROR',
  OUT_OF_SCOPE      = 'OUT_OF_SCOPE',
  /**
   * A 3xx redirect response was received.  The `Location` URL has been
   * submitted to the frontier and will be crawled normally (subject to
   * robots.txt, rate limits, and depth checks) rather than followed inline.
   */
  REDIRECT          = 'REDIRECT',
}

/**
 * Aggregate statistics for a completed crawl run.
 */
export interface CrawlSummary {
  readonly seedUrl:           string;
  readonly pagesCaptured:     number;
  readonly pagesIgnored:      number;
  readonly ignoredBreakdown:  Readonly<Partial<Record<IgnoreReason, number>>>;
  readonly durationMs:        number;
  /** True when the frontier drained naturally; false when `stop()` was called. */
  readonly completedNaturally: boolean;
  readonly startedAt:         Date;
  readonly completedAt:       Date;
  /** URLs discovered beyond `maxDepth` — exist but were not fetched. */
  readonly buriedUrls:        ReadonlySet<string>;
}
