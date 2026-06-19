/**
 * CookieJar — per-crawl-session cookie storage.
 *
 * Parses `Set-Cookie` response headers, stores cookies keyed by hostname,
 * and injects `Cookie` request headers on subsequent requests to the same
 * host. Scoped to a single crawl session — not persisted.
 *
 * **Design decisions**
 *
 * - Domain matching is by exact hostname, not domain-suffix (`.example.com`
 *   style). A crawler stays on one domain; suffix matching adds complexity
 *   with no practical gain.
 * - `Secure`, `HttpOnly`, and `SameSite` attributes are intentionally
 *   ignored — not relevant for a server-side crawler.
 * - Expired cookies (via `Max-Age` or `Expires`) are removed lazily on
 *   the next `cookiesFor()` call for that host.
 * - `Path` scoping is enforced: a cookie with `Path=/blog` is only sent
 *   for URLs whose pathname begins with `/blog`.
 *
 * @example
 * ```ts
 * const jar = new CookieJar();
 *
 * // After fetching https://example.com (which set a session cookie):
 * jar.processResponse('https://example.com/', result.responseHeaders);
 *
 * // On the next request to the same host:
 * const cookieHeader = jar.cookiesFor('https://example.com/page');
 * // → "session_id=abc123"
 * ```
 */
export class CookieJar {
  /** hostname → cookie name → stored cookie */
  private readonly store = new Map<string, Map<string, StoredCookie>>();

  /**
   * Returns the value to use as the `Cookie` request header for the given URL,
   * or `null` if no cookies apply. Expired cookies are pruned on access.
   */
  cookiesFor(url: string): string | null {
    const { hostname, pathname } = parseUrl(url);
    if (!hostname) return null;

    const jar = this.store.get(hostname);
    if (!jar || jar.size === 0) return null;

    const now = Date.now();
    const pairs: string[] = [];

    for (const [name, cookie] of jar) {
      // Prune expired
      if (cookie.expiresMs !== undefined && cookie.expiresMs <= now) {
        jar.delete(name);
        continue;
      }
      // Enforce path scope
      if (cookie.path && !pathname.startsWith(cookie.path)) continue;

      pairs.push(`${name}=${cookie.value}`);
    }

    return pairs.length > 0 ? pairs.join('; ') : null;
  }

  /**
   * Parses `Set-Cookie` headers from a response and updates the jar.
   * Call after every successful fetch with the response's `responseHeaders`.
   *
   * @param url     - The URL that was fetched (used to determine the host).
   * @param headers - The response headers object from `FetchResult`.
   */
  processResponse(url: string, headers: Readonly<Record<string, string[]>>): void {
    const { hostname } = parseUrl(url);
    if (!hostname) return;

    const setCookies = headers['set-cookie'];
    if (!setCookies || setCookies.length === 0) return;

    let jar = this.store.get(hostname);
    if (!jar) {
      jar = new Map<string, StoredCookie>();
      this.store.set(hostname, jar);
    }

    for (const raw of setCookies) {
      const cookie = parseSetCookie(raw);
      if (cookie) jar.set(cookie.name, cookie);
    }
  }

  /** Returns the total number of cookies currently held across all hosts. */
  size(): number {
    let total = 0;
    for (const jar of this.store.values()) total += jar.size;
    return total;
  }

  /** Clears all cookies (useful for testing). */
  clear(): void {
    this.store.clear();
  }
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface StoredCookie {
  name:        string;
  value:       string;
  expiresMs?:  number;   // undefined → session cookie
  path?:       string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseUrl(url: string): { hostname: string; pathname: string } {
  try {
    const u = new URL(url);
    return { hostname: u.hostname, pathname: u.pathname };
  } catch {
    return { hostname: '', pathname: '/' };
  }
}

/**
 * Parses a single `Set-Cookie` header value into a `StoredCookie`.
 * Returns `null` for malformed values.
 *
 * Format: `name=value; Path=/; Max-Age=3600; Expires=...; HttpOnly; Secure`
 */
function parseSetCookie(raw: string): StoredCookie | null {
  const parts = raw.split(';');
  const nameValue = parts[0];
  if (!nameValue) return null;

  const eq = nameValue.indexOf('=');
  if (eq < 0) return null;

  const name  = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  let expiresMs: number | undefined;
  let path: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part      = parts[i]!.trim();
    const lowerPart = part.toLowerCase();

    if (lowerPart.startsWith('max-age=')) {
      const age = parseInt(part.slice(8), 10);
      if (!isNaN(age)) {
        // Max-Age=0 means delete — represent as already expired
        expiresMs = age <= 0 ? 0 : Date.now() + age * 1_000;
      }
    } else if (lowerPart.startsWith('expires=')) {
      // Max-Age takes precedence over Expires per RFC 6265 §5.3
      if (expiresMs === undefined) {
        const d = new Date(part.slice(8).trim());
        if (!isNaN(d.getTime())) expiresMs = d.getTime();
      }
    } else if (lowerPart.startsWith('path=')) {
      path = part.slice(5).trim() || '/';
    }
    // Secure, HttpOnly, SameSite intentionally ignored
  }

  return {
    name,
    value,
    ...(expiresMs !== undefined && { expiresMs }),
    ...(path      !== undefined && { path }),
  };
}
