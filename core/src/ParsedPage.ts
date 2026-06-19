import type { CheerioAPI } from 'cheerio';
import type { FetchResult }  from './FetchResult.js';

/**
 * The input delivered to every registered {@link Extractor}.
 *
 * Bundles the raw {@link FetchResult} with a parsed Cheerio document
 * (for HTML responses) and the depth at which this URL was discovered.
 *
 * Non-HTML responses have `document = null`. Extractors that only
 * operate on HTML should check `isHtml()` before accessing the document.
 *
 * **Cheerio document thread-safety:** Cheerio's `$` function and the
 * underlying DOM are not safe for concurrent mutation. Extractors must
 * treat the document as read-only.
 */
export interface ParsedPage {
  readonly fetchResult: FetchResult;
  /** Non-null only for `text/html` 2xx responses. */
  readonly document:   CheerioAPI | null;
  readonly crawlDepth: number;
}

export namespace ParsedPage {
  /** True when a Cheerio document is available. */
  export function isHtml(p: ParsedPage): boolean {
    return p.document !== null;
  }

  /** Final URL after all redirects. */
  export function url(p: ParsedPage): string {
    return p.fetchResult.finalUri;
  }

  export function statusCode(p: ParsedPage): number {
    return p.fetchResult.statusCode;
  }

  export function create(
    fetchResult: FetchResult,
    document: CheerioAPI | null,
    crawlDepth: number,
  ): ParsedPage {
    if (crawlDepth < 0) throw new RangeError(`crawlDepth must be >= 0, got ${crawlDepth}`);
    return Object.freeze({ fetchResult, document, crawlDepth });
  }
}
