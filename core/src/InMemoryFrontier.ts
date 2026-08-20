import type { Frontier, FrontierEntry } from './Frontier.js';

/**
 * In-memory BFS frontier backed by a FIFO queue and a seen-URL set.
 *
 * - `submit()` is O(1) amortised.
 * - `next()` is O(1).
 * - `isDrained()` returns true only when the queue is empty **and** no URLs
 *   are currently in-flight — identical semantics to the Java implementation.
 */
export class InMemoryFrontier implements Frontier {
  private readonly queue:    FrontierEntry[] = [];
  private headIndex = 0;
  private readonly seen:     Set<string>     = new Set();
  private readonly inFlight: Set<string>     = new Set();

  submit(url: string, depth: number, referrer?: string): void {
    if (typeof url !== 'string' || !url) {
      throw new Error(`Frontier.submit() received an invalid URL: "${url}"`);
    }
    const norm = normalizeForSeen(url);
    if (this.seen.has(norm)) return;
    this.seen.add(norm);
    this.queue.push(referrer !== undefined ? { url, depth, referrer } : { url, depth });
  }

  next(): FrontierEntry | null {
    if (this.headIndex >= this.queue.length) {
      return null;
    }
    const entry = this.queue[this.headIndex++];
    if (!entry) return null;

    if (this.headIndex > 10_000 && this.headIndex > (this.queue.length >> 1)) {
      this.queue.splice(0, this.headIndex);
      this.headIndex = 0;
    }

    this.inFlight.add(entry.url);
    return entry;
  }

  complete(url: string): void {
    this.inFlight.delete(url);
  }

  isDrained(): boolean {
    return (this.queue.length - this.headIndex === 0) && this.inFlight.size === 0;
  }

  queueSize():     number { return this.queue.length - this.headIndex; }
  inFlightCount(): number { return this.inFlight.size; }
}

/**
 * Strips the fragment from a URL before adding to the seen set.
 * Two URLs that differ only in fragment are the same resource.
 */
function normalizeForSeen(url: string): string {
  const hash = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}
