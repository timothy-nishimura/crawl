import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
} from '../types/CrawlManifest.js';
import type { SeoData }     from '../extractors/SeoExtractor.js';
import type { MetaData }    from '../extractors/MetaExtractor.js';
import { normalizeUrl }     from '../lib/link-graph.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const CompareManifestsInput = z.object({
  crawlManifestPath: z
    .string()
    .describe('Absolute path to the crawl manifest (produced by the crawl tool with saveToFile).'),

  sitemapManifestPath: z
    .string()
    .describe('Absolute path to the sitemap manifest (produced by parse_sitemap).'),

  limit: z
    .number().int().min(1).max(500)
    .default(100)
    .describe('Maximum number of URLs to return per gap list. Increase for larger sites.'),
});

// ── Types ──────────────────────────────────────────────────────────────────────

interface GapEntry {
  url:      string;
  /** Reason the URL was missed or present — context-dependent. */
  note?:    string;
}

interface CrawledGapEntry extends GapEntry {
  title?:       string;
  statusCode:   number;
  depth:        number;
  /** True if the page has a noindex directive — explains why it's not in sitemap. */
  noindex:      boolean;
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `compare_manifests` tool on the given McpServer.
 *
 * Diffs a crawl manifest against a sitemap manifest to find gaps in either direction:
 *
 * In sitemap, not crawled
 *   URLs that Google sees in the sitemap but the crawler never reached.
 *   Causes: depth-capped, blocked by robots.txt, behind auth, crawl budget
 *   exhausted, or the URL returns an error. These pages may be invisible
 *   to your crawl-based tooling even though Google knows about them.
 *
 * Crawled, not in sitemap
 *   URLs the crawler discovered via internal links but that don't appear
 *   in the sitemap. May be intentional (utility pages, thank-you pages)
 *   or an oversight — pages Google may struggle to discover without a sitemap
 *   entry. Noindex pages in this bucket are usually correctly excluded.
 *
 * Both manifest types must share the same root domain for the comparison
 * to be meaningful.
 */
export function registerCompareManifests(server: McpServer): void {
  server.tool(
    'compare_manifests',

    'Diff a crawl manifest against a sitemap manifest to find indexability gaps. ' +
    'Reports URLs present in the sitemap but never crawled (potential depth/scope gaps), ' +
    'and URLs the crawler found that are absent from the sitemap (may be missing sitemap entries). ' +
    'Also flags crawled pages that are noindex — explaining why they\'d be absent from the sitemap.',

    CompareManifestsInput.shape,

    async (args) => {
      const input = CompareManifestsInput.parse(args);

      // ── Load manifests ─────────────────────────────────────────────────
      let crawlManifest, sitemapManifest;

      try {
        crawlManifest = loadManifest(input.crawlManifestPath);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Could not load crawl manifest: ${String(err)}` }) }],
          isError: true,
        };
      }

      try {
        sitemapManifest = loadManifest(input.sitemapManifestPath);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Could not load sitemap manifest: ${String(err)}` }) }],
          isError: true,
        };
      }

      if (!isCrawlManifest(crawlManifest)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'crawlManifestPath must point to a crawl manifest (source: "crawl").' }) }],
          isError: true,
        };
      }

      if (!isSitemapManifest(sitemapManifest)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'sitemapManifestPath must point to a sitemap manifest (source: "sitemap").' }) }],
          isError: true,
        };
      }

      // ── Domain mismatch warning ────────────────────────────────────────
      const warnings: string[] = [];
      const crawlHost   = (() => { try { return new URL(crawlManifest.meta.seedUrl).hostname; }   catch { return null; } })();
      const sitemapHost = (() => { try { return new URL(sitemapManifest.meta.sitemapUrl).hostname; } catch { return null; } })();
      if (crawlHost && sitemapHost && crawlHost !== sitemapHost) {
        warnings.push(
          `Domain mismatch: crawl was seeded from "${crawlHost}" but the sitemap belongs to "${sitemapHost}". ` +
          `Gap counts may be misleading — verify you are comparing manifests for the same site.`,
        );
      }

      // ── Build URL sets ─────────────────────────────────────────────────
      // Crawled pages — keyed by normalized URL, non-duplicate only
      const crawledMap = new Map<string, typeof crawlManifest.pages[number]>();
      for (const page of crawlManifest.pages) {
        if (page.isDuplicate) continue;
        crawledMap.set(normalizeUrl(page.url), page);
      }

      // Sitemap URLs — keyed by normalized URL
      const sitemapMap = new Map<string, typeof sitemapManifest.urls[number]>();
      for (const entry of sitemapManifest.urls) {
        sitemapMap.set(normalizeUrl(entry.url), entry);
      }

      // ── Gap 1: In sitemap, not crawled ─────────────────────────────────
      const inSitemapNotCrawled: GapEntry[] = [];
      for (const [normUrl, entry] of sitemapMap) {
        if (!crawledMap.has(normUrl)) {
          inSitemapNotCrawled.push({ url: entry.url });
        }
      }

      // ── Gap 2: Crawled, not in sitemap ─────────────────────────────────
      const crawledNotInSitemap: CrawledGapEntry[] = [];
      for (const [normUrl, page] of crawledMap) {
        if (!sitemapMap.has(normUrl)) {
          const seo  = page['mcp.seo']  as SeoData  | undefined;
          const meta = page['mcp.meta'] as MetaData  | undefined;

          const noindex = meta?.robots?.noindex ?? false;

          crawledNotInSitemap.push({
            url:        page.url,
            title:      seo?.title,
            statusCode: page.statusCode,
            depth:      page.depth,
            noindex,
            ...(noindex && { note: 'noindex — correct to exclude from sitemap' }),
            ...(!noindex && page.statusCode >= 400 && { note: `HTTP ${page.statusCode} — error page` }),
          });
        }
      }

      // Sort: depth then URL
      inSitemapNotCrawled.sort((a, b) => a.url.localeCompare(b.url));
      crawledNotInSitemap.sort((a, b) =>
        a.depth - b.depth || a.url.localeCompare(b.url),
      );

      // Partition crawledNotInSitemap for cleaner reporting
      const noindexPages     = crawledNotInSitemap.filter(p => p.noindex);
      const errorPages       = crawledNotInSitemap.filter(p => !p.noindex && p.statusCode >= 400);
      const genuineGapPages  = crawledNotInSitemap.filter(p => !p.noindex && p.statusCode < 400);

      // ── Response ──────────────────────────────────────────────────────
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              crawlManifestPath:   input.crawlManifestPath,
              sitemapManifestPath: input.sitemapManifestPath,
              crawledAt:           crawlManifest.meta.createdAt,
              seedUrl:             crawlManifest.meta.seedUrl,
              sitemapUrl:          sitemapManifest.meta.sitemapUrl,

              ...(warnings.length > 0 && { warnings }),

              crawledPageCount:  crawledMap.size,
              sitemapUrlCount:   sitemapMap.size,

              gaps: {
                inSitemapNotCrawled:   inSitemapNotCrawled.length,
                crawledNotInSitemap:   crawledNotInSitemap.length,
                genuineGapsNotInSitemap: genuineGapPages.length,
                noindexPagesNotInSitemap: noindexPages.length,
                errorPagesNotInSitemap:   errorPages.length,
              },
            },

            // Sitemap URLs the crawler never saw
            inSitemapNotCrawled: inSitemapNotCrawled.slice(0, input.limit),
            ...(inSitemapNotCrawled.length > input.limit && {
              inSitemapNotCrawledNote: `${inSitemapNotCrawled.length - input.limit} more not shown — increase limit`,
            }),

            // Crawled pages absent from sitemap — split into meaningful buckets
            crawledNotInSitemap: {
              // These are real gaps — good candidates for sitemap additions
              genuineGaps: genuineGapPages.slice(0, input.limit),
              ...(genuineGapPages.length > input.limit && {
                genuineGapsNote: `${genuineGapPages.length - input.limit} more not shown`,
              }),

              // These are expected — noindex pages shouldn't be in sitemaps
              noindexPages: noindexPages.slice(0, 50),
              ...(noindexPages.length > 50 && {
                noindexNote: `${noindexPages.length - 50} more not shown`,
              }),

              // Error pages in the crawl — may warrant investigation
              errorPages: errorPages.slice(0, 50),
            },
          }, null, 2),
        }],
      };
    },
  );
}
