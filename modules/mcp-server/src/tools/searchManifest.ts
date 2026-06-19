import { z }               from 'zod';
import type { McpServer }  from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
  type CrawlManifestPage,
  type SitemapEntry,
} from '../types/CrawlManifest.js';
import type { SeoData }    from '../extractors/SeoExtractor.js';

// ── Flag computation ───────────────────────────────────────────────────────────

/**
 * Derives structured SEO flag strings from a crawl page record.
 * The model should interpret flags — not raw numbers — to minimise reasoning load.
 */
function computeFlags(page: CrawlManifestPage, seo: SeoData | undefined): string[] {
  const flags: string[] = [];
  if (page.statusCode >= 500)                                    flags.push('ERR_5XX');
  else if (page.statusCode >= 400)                               flags.push('ERR_4XX');
  if (page.isDuplicate)                                          flags.push('WARN_DUPLICATE');
  if (!seo) return flags;
  if (!seo.h1)                                                   flags.push('ERR_MISSING_H1');
  if (!seo.description)                                          flags.push('ERR_MISSING_DESC');
  if ((seo.articleWordCount ?? 0) < 150)                         flags.push('WARN_THIN_CONTENT');
  if (seo.title.length > 60)                                     flags.push('WARN_TITLE_TOO_LONG');
  if (seo.title.length > 0 && seo.title.length < 30)            flags.push('WARN_TITLE_TOO_SHORT');
  if (seo.description.length > 160)                              flags.push('WARN_DESC_TOO_LONG');
  if (seo.description.length > 0 && seo.description.length < 50) flags.push('WARN_DESC_TOO_SHORT');
  return flags;
}

// ── Input schema ───────────────────────────────────────────────────────────────

const CRAWL_FIELDS = [
  'url', 'title', 'h1', 'description',
  'wordCount', 'articleWordCount',
  'statusCode', 'depth', 'flags',
] as const;

const SITEMAP_FIELDS = [
  'url', 'lastmod', 'priority', 'changefreq',
] as const;

const SearchManifestInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to the manifest file written by crawl (saveToFile) or parse_sitemap.'),

  urlPattern: z
    .string()
    .optional()
    .describe('Filter pages whose URL contains this substring (e.g. "/blog/", "weston").'),

  keyword: z
    .string()
    .optional()
    .describe(
      'Keyword to match against title, H1, and meta description (case-insensitive). ' +
      'Only applies to crawl manifests with mcp.seo extractor data.',
    ),

  minWordCount: z
    .number().int().min(0)
    .optional()
    .describe('Only return pages with wordCount >= this value (crawl manifests only).'),

  maxWordCount: z
    .number().int().min(0)
    .optional()
    .describe('Only return pages with wordCount <= this value (crawl manifests only).'),

  minArticleWordCount: z
    .number().int().min(0)
    .optional()
    .describe(
      'Only return pages with articleWordCount >= this value (crawl manifests only). ' +
      'articleWordCount is the Readability-extracted editorial count — more reliable than wordCount.',
    ),

  maxArticleWordCount: z
    .number().int().min(0)
    .optional()
    .describe('Only return pages with articleWordCount <= this value (crawl manifests only).'),

  hasFlag: z
    .string()
    .optional()
    .describe(
      'Only return pages that carry this SEO flag. ' +
      'Valid values: ERR_5XX, ERR_4XX, ERR_MISSING_H1, ERR_MISSING_DESC, WARN_DUPLICATE, ' +
      'WARN_THIN_CONTENT, WARN_TITLE_TOO_LONG, WARN_TITLE_TOO_SHORT, ' +
      'WARN_DESC_TOO_LONG, WARN_DESC_TOO_SHORT.',
    ),

  statusCode: z
    .number().int()
    .optional()
    .describe('Only return pages with this exact HTTP status code (crawl manifests only).'),

  modifiedAfter: z
    .string()
    .optional()
    .describe(
      'ISO 8601 date — only return sitemap entries with lastmod on or after this date ' +
      '(sitemap manifests only, e.g. "2025-01-01").',
    ),

  fields: z
    .array(z.enum([...CRAWL_FIELDS, ...SITEMAP_FIELDS]))
    .optional()
    .describe(
      'Fields to include in each result. Omit for a sensible default set. ' +
      'Use a minimal list to keep the response small (e.g. ["url", "title", "articleWordCount"]). ' +
      'articleWordCount is the Readability-extracted editorial word count — prefer this over wordCount for content depth analysis.',
    ),

  format: z
    .enum(['json', 'table'])
    .default('json')
    .describe(
      'Output format. "json" (default) returns an array of objects. ' +
      '"table" returns a pipe-delimited Markdown table — ~40% fewer tokens for large result sets.',
    ),

  limit: z
    .number().int().min(1).max(100)
    .default(20)
    .describe('Maximum number of results to return. Defaults to 20.'),

  offset: z
    .number().int().min(0)
    .default(0)
    .describe('Number of matching records to skip before returning results. Use with limit for pagination.'),
});

// ── Formatters ─────────────────────────────────────────────────────────────────

function toTable(results: Record<string, unknown>[]): string {
  if (results.length === 0) return '(no results)';
  const headers = Object.keys(results[0]!);
  const rows = results.map(r =>
    headers.map(h => {
      const v = r[h];
      if (Array.isArray(v)) return v.join(',');
      return String(v ?? '');
    }),
  );
  const separator = headers.map(() => '---');
  return [
    headers.join(' | '),
    separator.join(' | '),
    ...rows.map(r => r.join(' | ')),
  ].join('\n');
}

// ── Field projectors ───────────────────────────────────────────────────────────

function projectCrawlPage(
  page: CrawlManifestPage,
  fields?: readonly string[],
): Record<string, unknown> {
  const seo   = page['mcp.seo'] as SeoData | undefined;
  const flags = computeFlags(page, seo);

  const full: Record<string, unknown> = {
    url:              page.url,
    statusCode:       page.statusCode,
    depth:            page.depth,
    title:            seo?.title            ?? '',
    h1:               seo?.h1               ?? '',
    description:      seo?.description      ?? '',
    wordCount:        seo?.wordCount        ?? 0,
    articleWordCount: seo?.articleWordCount ?? 0,
    flags,
  };

  if (!fields || fields.length === 0) return full;
  return Object.fromEntries(fields.map(f => [f, full[f]]));
}

function projectSitemapEntry(
  entry: SitemapEntry,
  fields?: readonly string[],
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    url:        entry.url,
    lastmod:    entry.lastmod    ?? null,
    changefreq: entry.changefreq ?? null,
    priority:   entry.priority   ?? null,
  };

  if (!fields || fields.length === 0) return full;
  return Object.fromEntries(fields.map(f => [f, full[f]]));
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `search_manifest` tool on the given McpServer.
 *
 * Loads a manifest written by `crawl` (saveToFile) or `parse_sitemap` and runs
 * server-side filtering and projection.  Only matching records are returned —
 * the full manifest never enters context.
 *
 * Crawl filters: urlPattern, keyword, wordCount/articleWordCount range,
 *   statusCode, hasFlag.
 * Sitemap filters: urlPattern, modifiedAfter.
 *
 * Output: json (default) or pipe-delimited table (format: "table").
 * Pagination: use limit + offset to page through large result sets.
 * All filters are ANDed together.
 */
export function registerSearchManifestTool(server: McpServer): void {
  server.tool(
    'search_manifest',

    'Query a saved crawl or sitemap manifest file without loading it into context. ' +
    'Filter by URL pattern, keyword (title/H1/description), word count range, or date. ' +
    'Specify fields to project only what you need. Returns up to 100 matching records. ' +
    'Use after crawl (saveToFile) or parse_sitemap to find relevant pages efficiently.',

    SearchManifestInput.shape,

    async (args) => {
      const input = SearchManifestInput.parse(args);

      // ── Load manifest ─────────────────────────────────────────────────────
      let manifest;
      try {
        manifest = loadManifest(input.manifestPath);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Could not load manifest at ${input.manifestPath}: ${String(err)}`,
            }),
          }],
          isError: true,
        };
      }

      // ── Crawl manifest ────────────────────────────────────────────────────
      if (isCrawlManifest(manifest)) {
        const kwLower = input.keyword?.toLowerCase();

        const filtered = manifest.pages.filter(page => {
          if (input.urlPattern && !page.url.includes(input.urlPattern)) return false;
          if (input.statusCode !== undefined && page.statusCode !== input.statusCode) return false;

          const seo = page['mcp.seo'] as SeoData | undefined;

          if (input.minWordCount !== undefined && (seo?.wordCount ?? 0) < input.minWordCount) return false;
          if (input.maxWordCount !== undefined && (seo?.wordCount ?? 0) > input.maxWordCount) return false;

          const awc = seo?.articleWordCount ?? 0;
          if (input.minArticleWordCount !== undefined && awc < input.minArticleWordCount) return false;
          if (input.maxArticleWordCount !== undefined && awc > input.maxArticleWordCount) return false;

          if (kwLower) {
            const haystack = [
              seo?.title       ?? '',
              seo?.h1          ?? '',
              seo?.description ?? '',
            ].join(' ').toLowerCase();
            if (!haystack.includes(kwLower)) return false;
          }

          if (input.hasFlag) {
            const flags = computeFlags(page, seo);
            if (!flags.includes(input.hasFlag)) return false;
          }

          return true;
        });

        const totalMatched = filtered.length;
        const results = filtered
          .slice(input.offset, input.offset + input.limit)
          .map(page => projectCrawlPage(page, input.fields as readonly string[] | undefined));

        const meta = {
          source:       'crawl',
          manifestPath: input.manifestPath,
          seedUrl:      manifest.meta.seedUrl,
          totalPages:   manifest.pages.length,
          totalMatched,
          returned:     results.length,
          offset:       input.offset,
          limit:        input.limit,
        };

        const text = input.format === 'table'
          ? JSON.stringify(meta) + '\n\n' + toTable(results)
          : JSON.stringify({ ...meta, results });

        return { content: [{ type: 'text' as const, text }] };
      }

      // ── Sitemap manifest ──────────────────────────────────────────────────
      if (isSitemapManifest(manifest)) {
        const modAfter = input.modifiedAfter ? new Date(input.modifiedAfter) : undefined;

        const filtered = manifest.urls.filter(entry => {
          if (input.urlPattern && !entry.url.includes(input.urlPattern)) return false;
          if (modAfter && entry.lastmod) {
            const entryDate = new Date(entry.lastmod);
            if (isNaN(entryDate.getTime()) || entryDate < modAfter) return false;
          }
          return true;
        });

        const totalMatched = filtered.length;
        const results = filtered
          .slice(input.offset, input.offset + input.limit)
          .map(entry => projectSitemapEntry(entry, input.fields as readonly string[] | undefined));

        const meta = {
          source:       'sitemap',
          manifestPath: input.manifestPath,
          sitemapUrl:   manifest.meta.sitemapUrl,
          totalUrls:    manifest.urls.length,
          totalMatched,
          returned:     results.length,
          offset:       input.offset,
          limit:        input.limit,
        };

        const text = input.format === 'table'
          ? JSON.stringify(meta) + '\n\n' + toTable(results)
          : JSON.stringify({ ...meta, results });

        return { content: [{ type: 'text' as const, text }] };
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
