import { createHash } from 'node:crypto';

/**
 * Detects duplicate response bodies using SHA-256 hashing.
 *
 * Safe to use from concurrent async tasks — `Set` operations in Node.js
 * are not subject to interleaving between async tasks at the same await point,
 * so no locking is required.
 */
export class BodyDeduplicator {
  private readonly seen = new Set<string>();

  /**
   * Returns `true` if this body content has been seen before.
   * The first call for a given body returns `false` and records the hash.
   */
  isDuplicate(body: Uint8Array): boolean {
    if (body.length === 0) return false;
    const hash = createHash('sha256').update(body).digest('hex');
    if (this.seen.has(hash)) return true;
    this.seen.add(hash);
    return false;
  }

  reset(): void {
    this.seen.clear();
  }
}
