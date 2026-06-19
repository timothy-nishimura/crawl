import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, isCrawlManifest } from '../types/CrawlManifest.js';
import type { SchemaData } from '../extractors/SchemaExtractor.js';
import type { SeoData }    from '../extractors/SeoExtractor.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const AnalyzeSchemaInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to a crawl manifest produced with SchemaExtractor enabled (the default).'),

  includePageLists: z
    .boolean()
    .default(true)
    .describe('Include per-type page lists and the no-schema page list. Set false for summary only.'),

  schemaTypes: z
    .array(z.string())
    .optional()
    .describe(
      'If provided, only include these @type values in the per-type breakdown. ' +
      'Example: ["LocalBusiness", "Article", "FAQPage"]. ' +
      'If omitted, all types found are returned.',
    ),
});

// ── Types ──────────────────────────────────────────────────────────────────────

interface PageRef {
  url:   string;
  title: string;
  depth: number;
}

interface TypeEntry {
  type:       string;
  pageCount:  number;
  pages:      PageRef[];
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `analyze_schema` tool on the given McpServer.
 *
 * Analyses JSON-LD structured data coverage across the entire crawl:
 *
 * Coverage
 *   - Pages with no structured data at all (missing schema entirely)
 *   - Pages with at least one schema block
 *   - Schema adoption rate
 *
 * Type distribution
 *   - All @type values found, ranked by page count
 *   - Per-type page lists (optionally filtered to specific types)
 *
 * Common types to look for:
 *   LocalBusiness, RealEstateAgent, Organization, WebSite, WebPage,
 *   Article, BlogPosting, FAQPage, BreadcrumbList, Product, Review,
 *   AggregateRating, RealEstateListing, ItemList
 */
export function registerAnalyzeSchema(server: McpServer): void {
  server.tool(
    'analyze_schema',

    'Analyse JSON-LD structured data coverage across a crawl manifest. Reports pages with ' +
    'no schema, schema adoption rate, and a breakdown of all @type values found with page ' +
    'counts and lists. Filter to specific types with the schemaTypes parameter. ' +
    'Requires a manifest crawled with SchemaExtractor enabled (the default).',

    AnalyzeSchemaInput.shape,

    async (args) => {
      const input = AnalyzeSchemaInput.parse(args);

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
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'analyze_schema requires a crawl manifest.' }) }],
          isError: true,
        };
      }

      const hasSchemaData = manifest.pages.some(p => p['mcp.schema']);
      if (!hasSchemaData) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No schema data found in manifest. Re-crawl with SchemaExtractor enabled (the default).',
              extractors: manifest.meta.extractors,
            }),
          }],
          isError: true,
        };
      }

      // ── Accumulators ──────────────────────────────────────────────────────
      const noSchema:    PageRef[]                  = [];
      const typeMap:     Map<string, PageRef[]>     = new Map();
      let totalPages = 0;
      let pagesWithSchema = 0;

      const filterTypes = input.schemaTypes
        ? new Set(input.schemaTypes.map(t => t.toLowerCase()))
        : null;

      for (const page of manifest.pages) {
        if (page.isDuplicate) continue;
        totalPages++;

        const schema = page['mcp.schema'] as SchemaData | undefined;
        const seo    = page['mcp.seo']    as SeoData    | undefined;
        const ref: PageRef = {
          url:   page.url,
          title: seo?.title ?? '',
          depth: page.depth,
        };

        if (!schema || !schema.hasSchema) {
          noSchema.push(ref);
          continue;
        }

        pagesWithSchema++;

        // Record page against each unique @type found
        const seenTypes = new Set<string>();
        for (const type of schema.types) {
          if (seenTypes.has(type)) continue;
          seenTypes.add(type);

          // Apply filter if provided
          if (filterTypes && !filterTypes.has(type.toLowerCase())) continue;

          if (!typeMap.has(type)) typeMap.set(type, []);
          typeMap.get(type)!.push(ref);
        }
      }

      // Sort page lists
      const sortByDepth = (a: PageRef, b: PageRef) =>
        a.depth - b.depth || a.url.localeCompare(b.url);

      noSchema.sort(sortByDepth);

      // Build ranked type entries
      const typeEntries: TypeEntry[] = [...typeMap.entries()]
        .map(([type, pages]) => ({
          type,
          pageCount: pages.length,
          pages:     [...pages].sort(sortByDepth),
        }))
        .sort((a, b) => b.pageCount - a.pageCount || a.type.localeCompare(b.type));

      const adoptionRate = totalPages > 0
        ? Math.round((pagesWithSchema / totalPages) * 100)
        : 0;

      // ── Response ──────────────────────────────────────────────────────────
      const result: Record<string, unknown> = {
        summary: {
          manifestPath:   input.manifestPath,
          seedUrl:        manifest.meta.seedUrl,
          crawledAt:      manifest.meta.createdAt,
          pagesAnalyzed:  totalPages,
          pagesWithSchema,
          pagesWithoutSchema: noSchema.length,
          schemaAdoptionRate: `${adoptionRate}%`,
          uniqueTypesFound:   typeEntries.length,
          typesFound: typeEntries.map(e => ({ type: e.type, pageCount: e.pageCount })),
        },
      };

      if (input.includePageLists) {
        result['noSchema']      = noSchema;
        result['byType']        = typeEntries;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
