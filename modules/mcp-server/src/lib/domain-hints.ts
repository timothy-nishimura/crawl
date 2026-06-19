/**
 * domain-hints — heuristics for well-known domain categories.
 *
 * Used by MCP tools to surface warnings and apply appropriate delays.
 * These are application-level hints, not engine-level security policy.
 */

const SEARCH_ENGINES = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'baidu.com',
  'yandex.com',
];

const JS_GATED_DOMAINS = [
  ...SEARCH_ENGINES,
  'twitter.com',
  'x.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'reddit.com',
];

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Returns true if the URL belongs to a known search engine. */
export function isSearchEngine(url: string): boolean {
  const host = extractHost(url);
  if (!host) return false;
  return SEARCH_ENGINES.some(d => host === d || host.endsWith('.' + d));
}

/** Returns true if the URL belongs to a domain known to require JS rendering. */
export function isJsGated(url: string): boolean {
  const host = extractHost(url);
  if (!host) return false;
  return JS_GATED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}
