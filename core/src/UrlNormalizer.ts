/**
 * URL normalisation and resolution utilities.
 *
 * Mirrors the Java `UrlNormalizer`: resolves relative hrefs against a base,
 * optionally strips session parameters, forces lowercase scheme/host,
 * and removes default ports.
 */
export class UrlNormalizer {
  /** Session-parameter names that are stripped when `stripSessionParams` is true. */
  private static readonly SESSION_PARAMS = new Set([
    'jsessionid', 'phpsessid', 'aspsessionid', 'sessionid',
    'sid', 'cfid', 'cftoken',
  ]);

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

    // Normalise scheme and host to lowercase
    resolved.hostname = resolved.hostname.toLowerCase();

    // Strip default ports
    if ((resolved.protocol === 'http:'  && resolved.port === '80') ||
        (resolved.protocol === 'https:' && resolved.port === '443')) {
      resolved.port = '';
    }

    // Strip fragment
    resolved.hash = '';

    // Strip session parameters
    if (this.stripSessionParams) {
      for (const key of [...resolved.searchParams.keys()]) {
        if (UrlNormalizer.SESSION_PARAMS.has(key.toLowerCase())) {
          resolved.searchParams.delete(key);
        }
      }
    }

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
