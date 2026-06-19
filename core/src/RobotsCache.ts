import robotsParserModule from 'robots-parser';
import type { FetchBackend } from './FetchBackend.js';
import { FetchRequest }      from './FetchRequest.js';
import { FetchResult }       from './FetchResult.js';

// ── robots-parser type shim ───────────────────────────────────────────────────
// robots-parser@3.0.1 ships a malformed .d.ts: the shorthand ambient declaration
// `declare module 'robots-parser';` leaves the module opaque, so the default
// import resolves to the module namespace (non-callable) instead of the function.
// We cast once here; the runtime behaviour is identical.
interface RobotsTxt {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}
const robotsParser = robotsParserModule as unknown as
  (url: string, robotstxt: string) => RobotsTxt;

/**
 * Fetches and caches robots.txt files per host, then answers `isAllowed()` queries.
 *
 * - One `robots.txt` is fetched per unique host, then cached for the crawl session.
 * - A 404 or fetch error is treated as "all paths allowed" (permissive default).
 * - Concurrent requests for the same host coalesce into a single fetch via a
 *   promise cache — no double-fetching even under concurrent async workers.
 */
export class RobotsCache {
  /**
   * Maps host → Promise<robots instance>.
   * Storing the Promise (not the resolved value) means two concurrent
   * `isAllowed()` calls for the same new host share the in-flight fetch.
   */
  private readonly cache = new Map<string, Promise<RobotsTxt>>();

  constructor(
    private readonly backend:   FetchBackend,
    private readonly userAgent: string,
  ) {}

  /**
   * Returns `true` if crawling `url` is permitted by the host's robots.txt.
   */
  async isAllowed(url: string): Promise<boolean> {
    let host: string;
    let origin: string;
    try {
      const parsed = new URL(url);
      host   = parsed.host;
      origin = parsed.origin;
    } catch {
      return true; // can't parse → allow
    }

    const robots = await this.robotsFor(host, origin);
    return robots.isAllowed(url, this.userAgent) ?? true;
  }

  private robotsFor(
    host:   string,
    origin: string,
  ): Promise<RobotsTxt> {
    const cached = this.cache.get(host);
    if (cached) return cached;

    const promise = this.fetchRobots(origin);
    this.cache.set(host, promise);
    return promise;
  }

  private async fetchRobots(
    origin: string,
  ): Promise<RobotsTxt> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const result = await this.backend.fetch(
        FetchRequest.get(robotsUrl, 5_000),
      );

      if (!FetchResult.isSuccess(result) || result.body.length === 0) {
        return robotsParser(robotsUrl, '');
      }

      const text = FetchResult.bodyText(result);
      return robotsParser(robotsUrl, text);
    } catch {
      return robotsParser(robotsUrl, '');
    }
  }
}
