/**
 * URL normalisation and resolution utilities.
 *
 * Resolves relative hrefs against a base, strips session and tracking parameters,
 * sorts query parameters alphabetically, forces lowercase scheme/host,
 * and removes default ports.
 */
export class UrlNormalizer {
  /** Session-parameter names that are stripped when `stripSessionParams` is true. */
  private static readonly SESSION_PARAMS = new Set([
    'jsessionid', 'phpsessid', 'aspsessionid', 'sessionid',
    'sid', 'cfid', 'cftoken',
  ]);

  /** Common marketing / tracking parameters stripped to avoid spider traps. */
  private static readonly TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'zanpid',
    'mc_cid', 'mc_eid', 'igshid', '_hsenc', '_hsmi',
    'msclkid', 'yclid',
  ]);

  private static readonly TRACKING_PREFIXES = ['utm_'];

  constructor(private readonly stripSessionParams: boolean = true) {}

  /**
   * Resolves `href` against `base` and normalises the result.
   * Returns `null` for non-http(s) URLs, data URIs, javascript: links, etc.
   */
  resolve(base: string, href: string): string | null {
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#') ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('mailto:') ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('tel:')) {
      return null;
    }

    let resolved: URL;
    try {
      resolved = new URL(trimmed, base);
    } catch {
      return null;
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }

    return UrlNormalizer.normalizeUrlObject(resolved, this.stripSessionParams);
  }

  /**
   * Normalizes an absolute URL string.
   */
  static normalize(url: string, stripSessionParams: boolean = true): string | null {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return null;

    try {
      const u = new URL(trimmed);
      return UrlNormalizer.normalizeUrlObject(u, stripSessionParams);
    } catch {
      return null;
    }
  }

  private static normalizeUrlObject(resolved: URL, stripSessionParams: boolean): string {
    // Normalise scheme and host to lowercase
    resolved.protocol = resolved.protocol.toLowerCase();
    resolved.hostname = resolved.hostname.toLowerCase();

    // Strip default ports
    if ((resolved.protocol === 'http:'  && resolved.port === '80') ||
        (resolved.protocol === 'https:' && resolved.port === '443')) {
      resolved.port = '';
    }

    // Strip fragment
    resolved.hash = '';

    // Strip session and tracking parameters
    for (const key of [...resolved.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (
        (stripSessionParams && UrlNormalizer.SESSION_PARAMS.has(lowerKey)) ||
        UrlNormalizer.TRACKING_PARAMS.has(lowerKey) ||
        UrlNormalizer.TRACKING_PREFIXES.some(prefix => lowerKey.startsWith(prefix))
      ) {
        resolved.searchParams.delete(key);
      }
    }

    // Sort query parameters alphabetically for canonical deduplication
    resolved.searchParams.sort();

    // Normalise path: collapse double-slashes, remove trailing slash
    // (except root path which stays as "/")
    let path = resolved.pathname.replace(/\/+/g, '/');
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    resolved.pathname = path;

    return resolved.toString();
  }
}
