/**
 * BFS frontier — tracks pending URLs, in-flight URLs, and the seen set.
 *
 * Implementations must be safe to call from concurrent async tasks.
 * `submit()` is idempotent: submitting a seen URL is a no-op.
 */
export interface Frontier {
  /**
   * Add a URL to the queue at the given depth. No-op if already seen.
   *
   * @param referrer - The URL of the page that discovered this URL.
   *   Carried through to the FetchRequest as a `Referer` header.
   *   Not persisted — lost on job restart (correct behaviour: referer is
   *   only meaningful for the current request, not for resume).
   */
  submit(url: string, depth: number, referrer?: string): void;

  /**
   * Returns the next pending entry, or `null` if the queue is currently empty
   * (it may become non-empty if in-flight workers submit new URLs).
   */
  next(): FrontierEntry | null;

  /** Mark a URL as no longer in-flight (call after processing completes). */
  complete(url: string): void;

  /** True when the queue is empty AND no URLs are in-flight. */
  isDrained(): boolean;

  queueSize():    number;
  inFlightCount(): number;
}

export interface FrontierEntry {
  readonly url:      string;
  readonly depth:    number;
  /** The URL of the page that discovered this URL, if known. */
  readonly referrer?: string;
}
