import type { FetchResult } from './FetchResult.js';
import type { Extractor }   from './Extractor.js';

/**
 * Immutable snapshot of everything the engine captured about one fetched URL.
 *
 * The primary output type from the engine — one instance per crawled URL,
 * delivered via `for await (const snap of engine.crawl(config))`.
 *
 * @example
 * ```ts
 * for await (const snap of engine.crawl(config)) {
 *   if (snap.isBroken) console.log('Broken:', snap.url);
 *   const data = snap.extraction(myExtractor);
 *   if (data) process(data);
 * }
 * ```
 */
export class PageSnapshot {
  readonly url:         string;
  readonly fetchResult: FetchResult;
  readonly isDuplicate: boolean;
  readonly depth:       number;
  readonly capturedAt:  Date;

  /** Raw extraction map: extractor id → result. */
  private readonly _extractions: ReadonlyMap<string, unknown>;

  constructor(opts: {
    url:         string;
    fetchResult: FetchResult;
    extractions: Map<string, unknown>;
    isDuplicate: boolean;
    depth:       number;
    capturedAt:  Date;
  }) {
    if (opts.depth < 0) throw new RangeError(`depth must be >= 0, got ${opts.depth}`);
    this.url          = opts.url;
    this.fetchResult  = opts.fetchResult;
    this.isDuplicate  = opts.isDuplicate;
    this.depth        = opts.depth;
    this.capturedAt   = opts.capturedAt;
    this._extractions = new Map(opts.extractions);
    Object.freeze(this);
  }

  // ── HTTP convenience ───────────────────────────────────────────────────────

  get statusCode(): number  { return this.fetchResult.statusCode; }
  get isOk():       boolean { return this.statusCode >= 200 && this.statusCode < 300; }
  get isRedirect(): boolean { return this.statusCode >= 300 && this.statusCode < 400; }
  get isBroken():   boolean { return this.statusCode === 0 || this.statusCode >= 400; }

  // ── Extractor results ──────────────────────────────────────────────────────

  /**
   * Returns the typed result produced by the given extractor for this page,
   * or `null` if the extractor was not registered or returned nothing.
   */
  extraction<T>(extractor: Extractor<T>): T | null {
    const value = this._extractions.get(extractor.id());
    return value !== undefined ? (value as T) : null;
  }

  /** Raw access by extractor id — prefer `extraction()` for type safety. */
  extractionById(id: string): unknown {
    return this._extractions.get(id) ?? null;
  }

  get extractions(): ReadonlyMap<string, unknown> {
    return this._extractions;
  }
}
