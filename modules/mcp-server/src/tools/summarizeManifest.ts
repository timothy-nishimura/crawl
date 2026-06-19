import { z }               from 'zod';
import type { McpServer }  from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
  type CrawlManifestPage,
} from '../types/CrawlManifest.js';
import type { SeoData }   from '../extractors/SeoExtractor.js';
import type { LinkData }  from '../extractors/LinkExtractor.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const SummarizeManifestInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to the manifest file written by crawl (saveToFile) or parse_sitemap.'),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)]!;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function articleWcBuckets(counts: number[]): Record<string, number> {
  const b: Record<string, number> = {
    '<150': 0, '150-500': 0, '500-1k': 0, '1k-2k': 0, '2k-5k': 0, '5k+': 0,
  };
  for (const wc of counts) {
    if      (wc <  150)  b['<150']!++;
    else if (wc <  500)  b['150-500']!++;
    else if (wc < 1000)  b['500-1k']!++;
    else if (wc < 2000)  b['1k-2k']!++;
    else if (wc < 5000)  b['2k-5k']!++;
    else                 b['5k+']!++;
  }
  return b;
}

/** Compute SEO flag strings for a single crawl page. */
function pageFlags(page: CrawlManifestPage, seo: SeoData | undefined): string[] {
  const flags: string[] = [];
  if (page.statusCode >= 500)                              flags.push('ERR_5XX');
  else if (page.statusCode >= 400)                         flags.push('ERR_4XX');
  if (page.isDuplicate)                                    flags.push('WARN_DUPLICATE');
  if (!seo) return flags;
  if (!seo.h1)                                             flags.push('ERR_MISSING_H1');
  if (!seo.description)                                    flags.push('ERR_MISSING_DESC');
  if ((seo.articleWordCount ?? 0) < 150)                   flags.push('WARN_THIN_CONTENT');
  if (seo.title.length > 60)                               flags.push('WARN_TITLE_TOO_LONG');
  if (seo.title.length > 0 && seo.title.length < 30)      flags.push('WARN_TITLE_TOO_SHORT');
  if (seo.description.length > 160)                        flags.push('WARN_DESC_TOO_LONG');
  if (seo.description.length > 0 && seo.description.length < 50) flags.push('WARN_DESC_TOO_SHORT');
  return flags;
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `summarize_manifest` tool on the given McpServer.
 *
 * Returns a high-level statistical summary of a saved manifest without loading
 * any page data into context. Use this as the first step in an audit workflow
 * to understand the scope and health of a crawl before issuing targeted
 * search_manifest queries.
 *
 * Crawl manifests: page counts, status breakdown, content depth stats,
 *   SEO flag totals, duplicate count, depth distribution, top in-linked pages.
 *
 * Sitemap manifests: URL count, lastmod range, priority/changefreq distribution,
 *   URL depth distribution.
 */
export function registerSummarizeManifestTool(server: McpServer): void {
  server.tool(
    'summarize_manifest',

    'Return a high-level statistical summary of a crawl or sitemap manifest — without ' +
    'loading any page content into context. Returns page counts, status code breakdown, ' +
    'content depth distribution (articleWordCount buckets), SEO flag totals ' +
    '(ERR_MISSING_H1, WARN_THIN_CONTENT, etc.), duplicate count, and top in-linked pages ' +
    'when link data is present. Run this first to plan an audit before issuing ' +
    'targeted search_manifest queries.',

    SummarizeManifestInput.shape,

    async (args) => {
      const input = SummarizeManifestInput.parse(args);

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

      // ── Crawl manifest ────────────────────────────────────────────────────
      if (isCrawlManifest(manifest)) {
        const pages = manifest.pages;
        const total = pages.length;

        // Status code breakdown
        const statusCodes: Record<string, number> = {};
        for (const p of pages) {
          const key = String(p.statusCode);
          statusCodes[key] = (statusCodes[key] ?? 0) + 1;
        }

        // Depth distribution
        const depthDist: Record<string, number> = {};
        for (const p of pages) {
          const key = String(p.depth);
          depthDist[key] = (depthDist[key] ?? 0) + 1;
        }

        // Content depth stats
        const articleWcs: number[] = [];
        const rawWcs:     number[] = [];

        // SEO flag accumulators
        let missingH1 = 0, missingDesc = 0, thinContent = 0;
        let titleTooLong = 0, titleTooShort = 0, descTooLong = 0, descTooShort = 0;
        let duplicates = 0, errors4xx = 0, errors5xx = 0;

        for (const p of pages) {
          if (p.isDuplicate)        duplicates++;
          if (p.statusCode >= 500)  errors5xx++;
          else if (p.statusCode >= 400) errors4xx++;

          const seo = p['mcp.seo'] as SeoData | undefined;
          if (!seo) continue;

          const awc = seo.articleWordCount ?? 0;
          articleWcs.push(awc);
          rawWcs.push(seo.wordCount);

          if (!seo.h1)                                             missingH1++;
          if (!seo.description)                                    missingDesc++;
          if (awc < 150)                                           thinContent++;
          if (seo.title.length > 60)                               titleTooLong++;
          if (seo.title.length > 0 && seo.title.length < 30)      titleTooShort++;
          if (seo.description.length > 160)                        descTooLong++;
          if (seo.description.length > 0 && seo.description.length < 50) descTooShort++;
        }

        const sortedAwc = [...articleWcs].sort((a, b) => a - b);
        const sortedRaw = [...rawWcs].sort((a, b) => a - b);

        // In-link aggregation (requires mcp.links extractor)
        const hasLinkData = pages.some(p => p['mcp.links']);
        let topInLinkedPages: Array<{ url: string; inLinks: number }> = [];

        if (hasLinkData) {
          const inLinkCount: Record<string, number> = {};
          for (const p of pages) {
            const links = p['mcp.links'] as LinkData | undefined;
            if (!links) continue;
            for (const link of links.internal) {
              inLinkCount[link.href] = (inLinkCount[link.href] ?? 0) + 1;
            }
          }
          topInLinkedPages = Object.entries(inLinkCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([url, inLinks]) => ({ url, inLinks }));
        }

        // External link domain summary (if link data present)
        let topExternalDomains: Array<{ domain: string; count: number }> = [];
        if (hasLinkData) {
          const extDomains: Record<string, number> = {};
          for (const p of pages) {
            const links = p['mcp.links'] as LinkData | undefined;
            if (!links) continue;
            for (const link of links.external) {
              try {
                const domain = new URL(link.href).hostname;
                extDomains[domain] = (extDomains[domain] ?? 0) + 1;
              } catch { /* skip */ }
            }
          }
          topExternalDomains = Object.entries(extDomains)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([domain, count]) => ({ domain, count }));
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              source:       'crawl',
              manifestPath: input.manifestPath,
              crawledAt:    manifest.meta.createdAt,
              seedUrl:      manifest.meta.seedUrl,
              extractors:   manifest.meta.extractors,
              totalPages:   total,
              bypassBot:    manifest.meta.bypassBot,
              durationMs:   manifest.meta.durationMs,
              stoppedReason: manifest.meta.stoppedReason,

              statusCodes,
              depthDistribution: depthDist,
              duplicatePages: duplicates,

              contentDepth: {
                articleWordCount: {
                  min:    sortedAwc[0]                        ?? 0,
                  max:    sortedAwc[sortedAwc.length - 1]     ?? 0,
                  median: median(sortedAwc),
                  avg:    avg(articleWcs),
                },
                rawWordCount: {
                  min:    sortedRaw[0]                        ?? 0,
                  max:    sortedRaw[sortedRaw.length - 1]     ?? 0,
                  median: median(sortedRaw),
                  avg:    avg(rawWcs),
                },
                articleWordCountBuckets: articleWcBuckets(articleWcs),
              },

              seoFlags: {
                ERR_5XX:            errors5xx,
                ERR_4XX:            errors4xx,
                ERR_MISSING_H1:     missingH1,
                ERR_MISSING_DESC:   missingDesc,
                WARN_DUPLICATE:     duplicates,
                WARN_THIN_CONTENT:  thinContent,
                WARN_TITLE_TOO_LONG:  titleTooLong,
                WARN_TITLE_TOO_SHORT: titleTooShort,
                WARN_DESC_TOO_LONG:   descTooLong,
                WARN_DESC_TOO_SHORT:  descTooShort,
              },

              ...(hasLinkData && {
                linkAnalysis: {
                  topInLinkedPages,
                  topExternalDomains,
                },
              }),
            }),
          }],
        };
      }

      // ── Sitemap manifest ──────────────────────────────────────────────────
      if (isSitemapManifest(manifest)) {
        const urls   = manifest.urls;
        const total  = urls.length;

        const withLastmod  = urls.filter(u => u.lastmod).length;
        const withPriority = urls.filter(u => u.priority !== undefined).length;

        const dates = urls
          .filter(u => u.lastmod)
          .map(u => u.lastmod!)
          .sort();

        const priorityDist: Record<string, number> = {};
        for (const u of urls) {
          if (u.priority !== undefined) {
            const key = u.priority.toFixed(1);
            priorityDist[key] = (priorityDist[key] ?? 0) + 1;
          }
        }

        const changefreqDist: Record<string, number> = {};
        for (const u of urls) {
          if (u.changefreq) {
            changefreqDist[u.changefreq] = (changefreqDist[u.changefreq] ?? 0) + 1;
          }
        }

        // URL structural depth (path segment count)
        const depthDist: Record<string, number> = {};
        for (const u of urls) {
          try {
            const segments = new URL(u.url).pathname
              .split('/')
              .filter(Boolean).length;
            const key = String(segments);
            depthDist[key] = (depthDist[key] ?? 0) + 1;
          } catch { /* skip */ }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              source:       'sitemap',
              manifestPath: input.manifestPath,
              sitemapUrl:   manifest.meta.sitemapUrl,
              parsedAt:     manifest.meta.createdAt,
              totalUrls:    total,
              withLastmod,
              withPriority,
              oldestLastmod:  dates[0]                    ?? null,
              newestLastmod:  dates[dates.length - 1]     ?? null,
              priorityDistribution:  priorityDist,
              changefreqDistribution: changefreqDist,
              urlDepthDistribution:  depthDist,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Unknown manifest source type.' }),
        }],
        isError: true,
      };
    },
  );
}
