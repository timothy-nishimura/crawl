/**
 * link-graph — builds an in-memory directed link graph from a CrawlManifest.
 *
 * Used by:
 *   - modules/mcp-server/src/tools/analyzeLinks.ts  (MCP tool)
 *
 * The graph is built in two passes:
 *   Pass 1 — create a PageNode for every non-duplicate captured page.
 *   Pass 2 — for each page's mcp.links.internal array, wire outLinks/inLinks.
 *             Hrefs that resolve to uncaptured URLs are recorded as broken.
 *
 * Duplicate pages are excluded from the graph — their outbound links are not
 * counted (avoiding inflated in-link counts from HubSpot ?hsLang= variants).
 *
 * URL normalization before Map lookups: lowercase host, strip trailing slash
 * on non-root paths, strip fragment. This matches the crawler's normalizer
 * closely enough to prevent false "broken link" classifications caused by
 * minor href variations (e.g. trailing slash presence/absence).
 */

import type { CrawlManifest } from '../types/CrawlManifest.js';
import type { LinkData }      from '../extractors/LinkExtractor.js';
import type { SeoData }       from '../extractors/SeoExtractor.js';

// ── Public types ───────────────────────────────────────────────────────────────

export interface InLinkRef {
  /** Source page URL. */
  from:   string;
  /** Anchor text used on the source page. */
  anchor: string;
}

export interface PageNode {
  url:         string;
  statusCode:  number;
  depth:       number;
  isDuplicate: boolean;
  title?:      string;
  wordCount?:  number;
  /** Resolved, normalized target URLs of outbound internal links. */
  outLinks: string[];
  /** Pages that contain a link to this page. */
  inLinks:  InLinkRef[];
}

export interface BrokenLink {
  /** Page that contains the broken link. */
  from:   string;
  /** The unresolvable href. */
  href:   string;
  anchor: string;
}

export interface LinkGraph {
  seedUrl:   string;
  crawledAt: string;
  /** Number of non-duplicate pages in the graph. */
  pageCount: number;
  /** Total internal links wired (does not include broken links). */
  totalLinks: number;

  /** All graph nodes, keyed by normalized URL. */
  nodes: Map<string, PageNode>;

  /**
   * Pages with zero in-links (potential orphans).
   * The seed URL is excluded — it has no referrer by definition.
   * Sorted shallowest-first.
   */
  orphans: PageNode[];

  /**
   * Pages with zero out-links (dead-ends in the graph).
   * May be expected (privacy policy, contact pages) or unintended.
   * Sorted shallowest-first.
   */
  sinks: PageNode[];

  /**
   * Pages with exactly one in-link — one nav change away from becoming orphaned.
   * Sorted by source URL.
   */
  singlePath: PageNode[];

  /**
   * Internal link targets that could not be matched to a captured page.
   * Causes: 404, out-of-scope URL, depth-capped, or normalization mismatch.
   * Sorted by source URL.
   */
  broken: BrokenLink[];

  /** Top 25 pages by in-link count, descending. */
  topByInLinks: PageNode[];

  /** Top 25 pages by out-link count, descending. */
  topByOutLinks: PageNode[];
}

// ── Builder ────────────────────────────────────────────────────────────────────

export function buildLinkGraph(manifest: CrawlManifest): LinkGraph {
  // ── Pass 1: build node map ───────────────────────────────────────────────
  const nodes = new Map<string, PageNode>();

  for (const page of manifest.pages) {
    if (page.isDuplicate) continue;

    const seo = page['mcp.seo'] as SeoData | undefined;

    nodes.set(normalizeUrl(page.url), {
      url:         page.url,
      statusCode:  page.statusCode,
      depth:       page.depth,
      isDuplicate: page.isDuplicate,
      title:       seo?.title,
      wordCount:   seo?.wordCount,
      outLinks:    [],
      inLinks:     [],
    });
  }

  // ── Pass 2: wire links ───────────────────────────────────────────────────
  const broken: BrokenLink[] = [];
  let totalLinks = 0;

  for (const page of manifest.pages) {
    if (page.isDuplicate) continue;

    const fromNode = nodes.get(normalizeUrl(page.url));
    if (!fromNode) continue;

    const linkData = page['mcp.links'] as LinkData | undefined;
    if (!linkData) continue;

    for (const { href, anchor } of linkData.internal) {
      const targetKey = normalizeUrl(href);
      const target    = nodes.get(targetKey);

      if (target) {
        fromNode.outLinks.push(href);
        target.inLinks.push({ from: page.url, anchor });
        totalLinks++;
      } else {
        broken.push({ from: page.url, href, anchor });
      }
    }
  }

  // ── Classify ─────────────────────────────────────────────────────────────
  const seedKey = normalizeUrl(manifest.meta.seedUrl);

  const orphans:    PageNode[] = [];
  const sinks:      PageNode[] = [];
  const singlePath: PageNode[] = [];

  for (const node of nodes.values()) {
    if (node.inLinks.length === 0 && normalizeUrl(node.url) !== seedKey) {
      orphans.push(node);
    }
    if (node.outLinks.length === 0) sinks.push(node);
    if (node.inLinks.length === 1)  singlePath.push(node);
  }

  orphans.sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  sinks.sort((a, b)   => a.depth - b.depth || a.url.localeCompare(b.url));
  singlePath.sort((a, b) => a.url.localeCompare(b.url));
  broken.sort((a, b)     => a.from.localeCompare(b.from));

  const allNodes     = [...nodes.values()];
  const topByInLinks = [...allNodes]
    .sort((a, b) => b.inLinks.length - a.inLinks.length)
    .slice(0, 25);
  const topByOutLinks = [...allNodes]
    .sort((a, b) => b.outLinks.length - a.outLinks.length)
    .slice(0, 25);

  return {
    seedUrl:      manifest.meta.seedUrl,
    crawledAt:    manifest.meta.createdAt,
    pageCount:    nodes.size,
    totalLinks,
    nodes,
    orphans,
    sinks,
    singlePath,
    broken,
    topByInLinks,
    topByOutLinks,
  };
}

// ── URL helpers ────────────────────────────────────────────────────────────────

/**
 * Session parameter names stripped by the crawler's UrlNormalizer.
 * Must stay in sync with core/src/UrlNormalizer.ts SESSION_PARAMS.
 *
 * The crawler removes these from page.url at fetch time, but LinkExtractor
 * stores raw resolved hrefs which may still contain them. Stripping here
 * ensures href → node map lookups succeed, preventing false broken-link reports.
 */
const SESSION_PARAMS = new Set([
  'jsessionid', 'phpsessid', 'aspsessionid', 'sessionid',
  'sid', 'cfid', 'cftoken',
]);

/**
 * Normalizes a URL for use as a Map key.
 *
 * Mirrors the crawler's UrlNormalizer behaviour:
 *   - Strips trailing slash on non-root paths
 *   - Strips fragment
 *   - Strips session parameters (jsessionid, phpsessid, sid, etc.)
 *
 * Non-session query params are preserved — they may distinguish pages.
 * Keeping this in sync with UrlNormalizer prevents false broken-link reports
 * when hrefs in the HTML still carry session tokens the crawler has stripped.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);

    // Strip trailing slash on non-root paths
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // Strip fragment
    u.hash = '';

    // Strip session parameters (mirrors UrlNormalizer.SESSION_PARAMS)
    for (const key of [...u.searchParams.keys()]) {
      if (SESSION_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }

    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Converts a page URL into a vault-relative file path for Obsidian.
 *
 * ```
 * https://example.com/             →  index.md
 * https://example.com/products/    →  products.md
 * https://example.com/blog/post-1  →  blog/post-1.md
 * ```
 *
 * The resulting path is used both as the `.md` file location and,
 * without the `.md` extension, as the wikilink target: `[[blog/post-1]]`.
 */
export function urlToVaultPath(url: string): string {
  try {
    const u        = new URL(url);
    let   pathname = u.pathname;

    // Strip trailing slash (except root)
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    // Root → index
    if (pathname === '/') return 'index.md';

    // Strip leading slash, append .md
    return pathname.slice(1) + '.md';
  } catch {
    // Fallback for non-URL strings
    return 'unknown.md';
  }
}

/**
 * Returns the wikilink target for a URL — vault-relative path without `.md`.
 * Used inside `[[...]]` references.
 */
export function urlToWikilink(url: string): string {
  return urlToVaultPath(url).replace(/\.md$/, '');
}
