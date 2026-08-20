import type { Extractor, ParsedPage } from '@crawl/engine';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SchemaBlock {
  /**
   * Normalized @type value(s). JSON-LD allows @type to be a string or an
   * array — this is always an array for consistent downstream handling.
   * Example: ["LocalBusiness"] or ["Article", "NewsArticle"]
   */
  types: string[];

  /**
   * The raw parsed JSON-LD object. Consumers can inspect specific properties
   * (e.g. name, address, priceRange) without the extractor needing to know
   * the full vocabulary of every schema type.
   */
  raw: Record<string, unknown>;
}

export interface SchemaData {
  /**
   * All valid JSON-LD blocks found on the page, in document order.
   * Invalid JSON or non-object roots are silently dropped.
   */
  blocks: SchemaBlock[];

  /**
   * Flat de-duplicated list of all @type values across all blocks.
   * Useful for quick "does this page have X schema?" checks without
   * iterating blocks[].
   */
  types: string[];

  /**
   * True if at least one valid JSON-LD block was found.
   * A page with blocks.length === 0 has no structured data at all.
   */
  hasSchema: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalizes a JSON-LD @type value to a string array.
 * Handles: string, string[], undefined.
 */
function normalizeTypes(raw: unknown): string[] {
  if (typeof raw === 'string')  return [raw];
  if (Array.isArray(raw))       return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

/**
 * Recursively extracts all @graph items from a JSON-LD root.
 * JSON-LD allows a top-level @graph array where each element is a node.
 */
function flattenGraph(root: Record<string, unknown>): Record<string, unknown>[] {
  const graph = root['@graph'];
  if (Array.isArray(graph)) {
    const items: Record<string, unknown>[] = [];
    for (const item of graph) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        items.push(item as Record<string, unknown>);
      }
    }
    return items;
  }
  // No @graph — treat the root as a single node
  return [root];
}

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Extracts and parses all JSON-LD structured data blocks from each crawled page.
 *
 * Design:
 * - Handles multiple <script type="application/ld+json"> blocks per page
 * - Flattens @graph arrays so each typed node is a separate SchemaBlock
 * - Normalizes @type to string[] regardless of source format
 * - Silently drops parse errors and non-object roots (common with malformed schema)
 * - Captures the raw object so consumers can inspect any property
 *
 * Output stored in CrawlManifestPage under key 'mcp.schema'.
 *
 * Common @type values to look for in real estate and local business contexts:
 *   LocalBusiness, RealEstateAgent, RealEstateListing, Organization,
 *   WebPage, WebSite, Article, BlogPosting, FAQPage, BreadcrumbList,
 *   ItemList, Product, Review, AggregateRating
 */
export class SchemaExtractor implements Extractor<SchemaData> {
  id(): string { return 'mcp.schema'; }

  extract(page: ParsedPage): SchemaData | null {
    const doc = page.document;
    if (!doc) return null;

    const blocks: SchemaBlock[] = [];

    doc('script[type="application/ld+json"]').each((_i, el) => {
      const raw = doc(el).html() ?? '';
      if (!raw.trim()) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // silently drop malformed JSON
      }

      // Root must be an object (or array of objects)
      const roots: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const root of roots) {
        if (root === null || typeof root !== 'object' || Array.isArray(root)) continue;

        const rootObj = root as Record<string, unknown>;
        const nodes   = flattenGraph(rootObj);

        for (const node of nodes) {
          const types = normalizeTypes(node['@type']);
          // Include node even if @type is absent — some schemas omit it at
          // the top level and rely on context. We record an empty types array.
          blocks.push({ types, raw: node });
        }
      }
    });

    // Flat de-duplicated type list across all blocks
    const allTypes = [...new Set(blocks.flatMap(b => b.types))];

    return {
      blocks,
      types:     allTypes,
      hasSchema: blocks.length > 0,
    };
  }
}
