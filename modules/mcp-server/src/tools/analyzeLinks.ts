import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, isCrawlManifest } from '../types/CrawlManifest.js';
import { buildLinkGraph }                from '../lib/link-graph.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const AnalyzeLinksInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to a crawl manifest file written by crawl (saveToFile).'),

  includeOrphans: z
    .boolean()
    .default(true)
    .describe('Include the full orphan page list in the response (pages with zero in-links, excluding seed).'),

  includeBroken: z
    .boolean()
    .default(true)
    .describe('Include the full broken link list (internal hrefs that resolved to no captured page).'),

  includeSinglePath: z
    .boolean()
    .default(true)
    .describe('Include pages reachable by only one in-link (one nav change away from becoming orphaned).'),

  includeTopPages: z
    .boolean()
    .default(true)
    .describe('Include top-25 pages by in-link and out-link count.'),
});

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `analyze_links` tool on the given McpServer.
 *
 * Builds a directed link graph from a saved crawl manifest and returns a
 * structured analysis of the site's internal linking health.
 *
 * Key outputs:
 *   - Orphan pages  — zero in-links (excluding seed). Likely invisible to search.
 *   - Sink pages    — zero out-links. Dead-ends in the crawl graph.
 *   - Single-path   — exactly one in-link; one nav change away from becoming orphaned.
 *   - Broken links  — internal hrefs that couldn't be matched to a captured page.
 *   - Top by in-links  — hub pages that attract the most internal authority.
 *   - Top by out-links — pages that distribute the most internal links.
 *
 * This tool requires the manifest to have been produced with the LinkExtractor
 * enabled (the default when using the `crawl` tool). Manifests produced by
 * parse_sitemap do not contain link data and are rejected.
 */
export function registerAnalyzeLinks(server: McpServer): void {
  server.tool(
    'analyze_links',

    'Build a directed internal link graph from a saved crawl manifest and return a ' +
    'structured analysis of the site\'s internal linking health. Identifies orphan pages ' +
    '(zero in-links), sink pages (zero out-links), single-path pages (one in-link, ' +
    'fragile), broken internal links (hrefs that resolve to no captured page), and ' +
    'top hub pages by in-link and out-link count. Requires a manifest produced by the ' +
    'crawl tool with link extraction enabled (the default).',

    AnalyzeLinksInput.shape,

    async (args) => {
      const input = AnalyzeLinksInput.parse(args);

      // ── Load manifest ─────────────────────────────────────────────────────
      let manifest;
      try {
        manifest = loadManifest(input.manifestPath);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Could not load manifest: ${String(err)}` }),
          }],
          isError: true,
        };
      }

      if (!isCrawlManifest(manifest)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'analyze_links requires a crawl manifest (source: "crawl"). ' +
                     'Sitemap manifests do not contain link data.',
            }),
          }],
          isError: true,
        };
      }

      const hasLinks = manifest.pages.some(p => p['mcp.links']);
      if (!hasLinks) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No link data found in manifest. Re-crawl with link extraction enabled ' +
                     '(the default). Check that "mcp.links" appears in manifest.meta.extractors.',
              extractors: manifest.meta.extractors,
            }),
          }],
          isError: true,
        };
      }

      // ── Build graph ───────────────────────────────────────────────────────
      const graph = buildLinkGraph(manifest);

      // ── Format response ───────────────────────────────────────────────────
      const summary = {
        seedUrl:    graph.seedUrl,
        crawledAt:  graph.crawledAt,
        pageCount:  graph.pageCount,
        totalInternalLinks: graph.totalLinks,

        orphanCount:     graph.orphans.length,
        sinkCount:       graph.sinks.length,
        singlePathCount: graph.singlePath.length,
        brokenLinkCount: graph.broken.length,
      };

      const result: Record<string, unknown> = { summary };

      if (input.includeOrphans) {
        result['orphans'] = graph.orphans.map(n => ({
          url:       n.url,
          depth:     n.depth,
          title:     n.title    ?? '',
          wordCount: n.wordCount ?? 0,
        }));
      }

      if (input.includeSinglePath) {
        result['singlePath'] = graph.singlePath.map(n => ({
          url:        n.url,
          depth:      n.depth,
          title:      n.title ?? '',
          linkedFrom: n.inLinks[0]?.from ?? '',
          anchor:     n.inLinks[0]?.anchor ?? '',
        }));
      }

      if (input.includeBroken) {
        result['broken'] = graph.broken.map(b => ({
          from:   b.from,
          href:   b.href,
          anchor: b.anchor,
        }));
      }

      // Always include sink summary (compact — just count + top offenders)
      result['sinks'] = graph.sinks.slice(0, 25).map(n => ({
        url:   n.url,
        depth: n.depth,
        title: n.title ?? '',
      }));
      if (graph.sinks.length > 25) {
        result['sinksNote'] = `${graph.sinks.length - 25} more sinks not shown`;
      }

      if (input.includeTopPages) {
        result['topByInLinks'] = graph.topByInLinks.map(n => ({
          url:      n.url,
          inLinks:  n.inLinks.length,
          outLinks: n.outLinks.length,
          title:    n.title ?? '',
        }));
        result['topByOutLinks'] = graph.topByOutLinks.map(n => ({
          url:      n.url,
          outLinks: n.outLinks.length,
          inLinks:  n.inLinks.length,
          title:    n.title ?? '',
        }));
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );
}
