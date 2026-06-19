import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, isCrawlManifest } from '../types/CrawlManifest.js';
import type { HeadingData } from '../extractors/HeadingExtractor.js';
import type { SeoData }     from '../extractors/SeoExtractor.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const AnalyzeHeadingsInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to a crawl manifest produced with HeadingExtractor enabled (the default).'),

  includePageLists: z
    .boolean()
    .default(true)
    .describe('Include per-issue page lists. Set false for a counts-only summary on large sites.'),
});

// ── Types ──────────────────────────────────────────────────────────────────────

interface PageRef {
  url:   string;
  title: string;
  depth: number;
}

interface MultipleH1Page extends PageRef {
  h1Count: number;
  h1Texts: string[];
}

interface SkippedLevelPage extends PageRef {
  /** The specific level transition that triggered the skip, e.g. "H2 → H4". */
  firstSkip: string;
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `analyze_headings` tool on the given McpServer.
 *
 * Analyses heading structure across the entire crawl:
 *
 * - Missing H1      — page has no H1 at all (strong ranking signal missing)
 * - Multiple H1     — page has two or more H1s (dilutes the primary topic signal)
 * - H1 not first    — content headings appear before the H1 (structural confusion)
 * - Skipped levels  — heading hierarchy jumps more than one level (e.g. H2 → H4)
 *
 * Also surfaces heading count distributions across the site for benchmark context.
 */
export function registerAnalyzeHeadings(server: McpServer): void {
  server.tool(
    'analyze_headings',

    'Analyse heading structure (H1–H6) across a crawl manifest. Reports pages with missing H1, ' +
    'multiple H1s, H1 not appearing first, and skipped heading levels. Includes site-wide ' +
    'heading count distributions. Requires a manifest crawled with HeadingExtractor enabled (the default).',

    AnalyzeHeadingsInput.shape,

    async (args) => {
      const input = AnalyzeHeadingsInput.parse(args);

      let manifest;
      try {
        manifest = loadManifest(input.manifestPath);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Could not load manifest: ${String(err)}` }) }],
          isError: true,
        };
      }

      if (!isCrawlManifest(manifest)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'analyze_headings requires a crawl manifest.' }) }],
          isError: true,
        };
      }

      const hasHeadingData = manifest.pages.some(p => p['mcp.headings']);
      if (!hasHeadingData) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No heading data found in manifest. Re-crawl with HeadingExtractor enabled (the default).',
              extractors: manifest.meta.extractors,
            }),
          }],
          isError: true,
        };
      }

      // ── Accumulators ──────────────────────────────────────────────────────
      const missingH1:     PageRef[]          = [];
      const multipleH1:    MultipleH1Page[]   = [];
      const h1NotFirst:    PageRef[]          = [];
      const skippedLevels: SkippedLevelPage[] = [];

      // Heading count distributions
      const h1Dist: Record<number, number> = {};
      const h2Dist: Record<number, number> = {};

      let totalPages = 0;

      for (const page of manifest.pages) {
        if (page.isDuplicate) continue;
        totalPages++;

        const headings = page['mcp.headings'] as HeadingData | undefined;
        const seo      = page['mcp.seo']      as SeoData     | undefined;

        if (!headings) continue;

        const ref: PageRef = {
          url:   page.url,
          title: seo?.title ?? '',
          depth: page.depth,
        };

        // ── Issue flags (pre-computed by extractor) ────────────────────────
        if (headings.issues.missingH1)     missingH1.push(ref);
        if (headings.issues.h1NotFirst)    h1NotFirst.push(ref);

        if (headings.issues.multipleH1) {
          const h1Texts = headings.headings
            .filter(h => h.level === 1)
            .map(h => h.text);
          multipleH1.push({ ...ref, h1Count: headings.counts.h1, h1Texts });
        }

        if (headings.issues.skippedLevels) {
          // Find the first skip for reporting context
          let firstSkip = '';
          for (let i = 1; i < headings.headings.length; i++) {
            const prev = headings.headings[i - 1]!.level;
            const curr = headings.headings[i]!.level;
            if (curr > prev + 1) {
              firstSkip = `H${prev} → H${curr}`;
              break;
            }
          }
          skippedLevels.push({ ...ref, firstSkip });
        }

        // ── Distributions ──────────────────────────────────────────────────
        const h1c = headings.counts.h1;
        const h2c = headings.counts.h2;
        h1Dist[h1c] = (h1Dist[h1c] ?? 0) + 1;
        h2Dist[h2c] = (h2Dist[h2c] ?? 0) + 1;
      }

      // Sort page lists by depth then URL for consistent ordering
      const sortByDepth = (a: PageRef, b: PageRef) =>
        a.depth - b.depth || a.url.localeCompare(b.url);

      missingH1.sort(sortByDepth);
      multipleH1.sort(sortByDepth);
      h1NotFirst.sort(sortByDepth);
      skippedLevels.sort(sortByDepth);

      // ── Response ──────────────────────────────────────────────────────────
      const result: Record<string, unknown> = {
        summary: {
          manifestPath:  input.manifestPath,
          seedUrl:       manifest.meta.seedUrl,
          crawledAt:     manifest.meta.createdAt,
          pagesAnalyzed: totalPages,

          issues: {
            missingH1Count:     missingH1.length,
            multipleH1Count:    multipleH1.length,
            h1NotFirstCount:    h1NotFirst.length,
            skippedLevelsCount: skippedLevels.length,
          },

          // Distributions keyed by count (sorted numerically)
          h1Distribution: Object.fromEntries(
            Object.entries(h1Dist).sort((a, b) => Number(a[0]) - Number(b[0])),
          ),
          h2Distribution: Object.fromEntries(
            Object.entries(h2Dist).sort((a, b) => Number(a[0]) - Number(b[0])),
          ),
        },
      };

      if (input.includePageLists) {
        result['missingH1']     = missingH1;
        result['multipleH1']    = multipleH1;
        result['h1NotFirst']    = h1NotFirst;
        result['skippedLevels'] = skippedLevels;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
