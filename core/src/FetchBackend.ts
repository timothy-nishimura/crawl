import type { FetchRequest } from './FetchRequest.js';
import type { FetchResult }  from './FetchResult.js';

/**
 * Pluggable HTTP transport layer.
 *
 * Every request passes through this interface, making it possible to:
 * - Swap in a Playwright backend for JS rendering.
 * - Inject a mock in tests — no network required.
 * - Add a caching, proxy, or cookie-injection layer.
 *
 * **Contract:**
 * - `fetch()` must never reject. On any error, return a `FetchResult` with
 *   `statusCode = 0` and `error` set.
 * - `fetch()` must be safe to call concurrently from multiple async tasks.
 * - `close()` releases resources (connection pools, browser processes, etc.).
 *   Calling it twice must be a no-op.
 */
export interface FetchBackend {
  fetch(request: FetchRequest): Promise<FetchResult>;
  close(): Promise<void> | void;
}
