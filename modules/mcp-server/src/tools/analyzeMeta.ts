import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, isCrawlManifest } from '../types/CrawlManifest.js';
import type { MetaData }  from '../extractors/MetaExtractor.js';
import type { SeoData }   from '../extractors/SeoExtractor.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const AnalyzeMetaInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to a crawl manifest produced with MetaExtractor enabled (the default).'),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

interface PageRef {
  url:   string;
  title: string;
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `analyze_meta` tool on the given McpServer.
 *
 * Analyses page-level meta signals across the entire crawl:
 *
 * Indexability
 *   - Pages marked noindex (intentional exclusions from search)
 *   - Pages marked nofollow at the meta level
 *
 * Canonicalization
 *   - Pages with no canonical tag (search engine has to guess)
 *   - Pages where canonical ≠ page URL (cross-page canonicals — may indicate
 *     intentional consolidation or an unintentional duplicate signal)
 *   - Pages where canonical points to a different domain (risky)
 *
 * Social sharing
 *   - Pages missing og:title, og:description, og:image
 *   - Pages missing twitter:card
 *   - Pages with no OG tags at all
 *
 * Mobile / technical
 *   - Pages missing a viewport meta tag
 *   - Hreflang summary: total pages, language set, pages with hreflang
 *
 * Requires the manifest to have been produced with MetaExtractor enabled.
 */
export function registerAnalyzeMeta(server: McpServer): void {
  server.tool(
    'analyze_meta',

    'Analyse page-level meta signals across a crawl manifest. Reports: noindex/nofollow pages, ' +
    'missing or conflicting canonical tags, Open Graph coverage gaps, missing Twitter Card, ' +
    'missing viewport (mobile-friendliness), and a hreflang language summary. ' +
    'Requires a manifest crawled with MetaExtractor enabled (the default).',

    AnalyzeMetaInput.shape,

    async (args) => {
      const input = AnalyzeMetaInput.parse(args);

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
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'analyze_meta requires a crawl manifest.' }) }],
          isError: true,
        };
      }

      const hasMetaData = manifest.pages.some(p => p['mcp.meta']);
      if (!hasMetaData) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No meta data found in manifest. Re-crawl with MetaExtractor enabled (the default).',
              extractors: manifest.meta.extractors,
            }),
          }],
          isError: true,
        };
      }

      // ── Accumulators ──────────────────────────────────────────────────────
      const noindex:           PageRef[] = [];
      const nofollow:          PageRef[] = [];
      const missingCanonical:  PageRef[] = [];
      const crossPageCanonical: Array<PageRef & { canonical: string }> = [];
      const crossDomainCanonical: Array<PageRef & { canonical: string }> = [];
      const missingOgAll:      PageRef[] = [];
      const missingOgTitle:    PageRef[] = [];
      const missingOgDesc:     PageRef[] = [];
      const missingOgImage:    PageRef[] = [];
      const missingTwitter:    PageRef[] = [];
      const missingViewport:   PageRef[] = [];

      const hreflangLanguages = new Set<string>();
      let pagesWithHreflang = 0;
      let totalPages = 0;

      for (const page of manifest.pages) {
        if (page.isDuplicate) continue;
        totalPages++;

        const meta = page['mcp.meta'] as MetaData | undefined;
        const seo  = page['mcp.seo']  as SeoData  | undefined;
        const ref: PageRef = { url: page.url, title: seo?.title ?? '' };

        if (!meta) continue;

        // ── Indexability ───────────────────────────────────────────────────
        if (meta.robots?.noindex)  noindex.push(ref);
        if (meta.robots?.nofollow) nofollow.push(ref);

        // ── Canonicalization ───────────────────────────────────────────────
        if (!meta.canonical) {
          missingCanonical.push(ref);
        } else {
          try {
            const canonUrl  = new URL(meta.canonical);
            const pageUrl   = new URL(page.url);

            if (canonUrl.hostname !== pageUrl.hostname) {
              crossDomainCanonical.push({ ...ref, canonical: meta.canonical });
            } else if (meta.canonical !== page.url) {
              crossPageCanonical.push({ ...ref, canonical: meta.canonical });
            }
          } catch {
            // unparseable canonical — treat as cross-page
            crossPageCanonical.push({ ...ref, canonical: meta.canonical });
          }
        }

        // ── Open Graph ─────────────────────────────────────────────────────
        if (!meta.openGraph) {
          missingOgAll.push(ref);
        } else {
          if (!meta.openGraph.title)       missingOgTitle.push(ref);
          if (!meta.openGraph.description) missingOgDesc.push(ref);
          if (!meta.openGraph.image)       missingOgImage.push(ref);
        }

        // ── Twitter Card ───────────────────────────────────────────────────
        if (!meta.twitterCard) missingTwitter.push(ref);

        // ── Viewport ───────────────────────────────────────────────────────
        if (!meta.viewport) missingViewport.push(ref);

        // ── Hreflang ───────────────────────────────────────────────────────
        if (meta.hreflang.length > 0) {
          pagesWithHreflang++;
          for (const entry of meta.hreflang) {
            hreflangLanguages.add(entry.hreflang);
          }
        }
      }

      // ── Response ──────────────────────────────────────────────────────────
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              manifestPath:  input.manifestPath,
              seedUrl:       manifest.meta.seedUrl,
              crawledAt:     manifest.meta.createdAt,
              pagesAnalyzed: totalPages,

              indexability: {
                noindexCount:  noindex.length,
                nofollowCount: nofollow.length,
              },
              canonicalization: {
                missingCount:         missingCanonical.length,
                crossPageCount:       crossPageCanonical.length,
                crossDomainCount:     crossDomainCanonical.length,
              },
              openGraph: {
                missingAllCount:         missingOgAll.length,
                missingTitleCount:       missingOgTitle.length,
                missingDescriptionCount: missingOgDesc.length,
                missingImageCount:       missingOgImage.length,
              },
              twitterCard: {
                missingCount: missingTwitter.length,
              },
              mobile: {
                missingViewportCount: missingViewport.length,
              },
              hreflang: {
                pagesWithHreflang,
                languagesFound: [...hreflangLanguages].sort(),
              },
            },

            // ── Detail lists ───────────────────────────────────────────────
            noindex,
            nofollow,

            canonicalization: {
              missing:     missingCanonical,
              crossPage:   crossPageCanonical,
              crossDomain: crossDomainCanonical,
            },

            openGraph: {
              missingAll:         missingOgAll,
              missingTitle:       missingOgTitle,
              missingDescription: missingOgDesc,
              missingImage:       missingOgImage,
            },

            missingTwitterCard: missingTwitter,
            missingViewport:    missingViewport,
          }, null, 2),
        }],
      };
    },
  );
}
