import type { ParsedPage } from './ParsedPage.js';

/**
 * Typed extractor that derives a structured result from a crawled page.
 *
 * Implementations must be:
 * - **Stateless** — called concurrently from multiple async tasks.
 * - **Exception-safe** — thrown errors are caught by the engine, logged, and
 *   do not fail the page. Return `null` to signal "nothing to report."
 * - **Stable id** — `id()` must be consistent across restarts. Two extractors
 *   with the same id in one engine instance are not permitted.
 *
 * @example
 * ```ts
 * class PriceExtractor implements Extractor<number> {
 *   id() { return 'ecommerce.price'; }
 *   extract(page: ParsedPage): number | null {
 *     const text = page.document?.('[data-price]').first().text();
 *     return text ? parseFloat(text.replace(/[^0-9.]/g, '')) : null;
 *   }
 * }
 * ```
 */
export interface Extractor<T> {
  /** Stable, unique dot-notation identifier (e.g. `"seo.standard"`, `"sierra.detail"`). */
  id(): string;

  /**
   * Extracts a typed result from the given parsed page.
   * Return `null` to indicate no result for this page.
   */
  extract(page: ParsedPage): T | null;
}
