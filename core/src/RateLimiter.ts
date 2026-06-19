/**
 * Simple mutex-based rate limiter to prevent parallel requests to sensitive domains.
 */
export class RateLimiter {
  private static locks = new Map<string, Promise<void>>();

  /**
   * Waits for a domain-specific lock to be released, then executes the task.
   * Ensures that only one task for the given key runs at a time.
   */
  static async synchronized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const currentLock = RateLimiter.locks.get(key) || Promise.resolve();
    
    let resolveLock: () => void;
    const nextLock = new Promise<void>(resolve => {
      resolveLock = resolve;
    });
    
    RateLimiter.locks.set(key, nextLock);

    try {
      await currentLock;
      return await task();
    } finally {
      resolveLock!();
      // Cleanup the map if no one else is waiting (optional optimization)
      if (RateLimiter.locks.get(key) === nextLock) {
        RateLimiter.locks.delete(key);
      }
    }
  }

  /**
   * Helper to sleep for a given duration.
   */
  static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
