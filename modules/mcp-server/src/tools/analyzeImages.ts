import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, isCrawlManifest } from '../types/CrawlManifest.js';
import type { ImageData } from '../extractors/ImageExtractor.js';
import type { SeoData }   from '../extractors/SeoExtractor.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const AnalyzeImagesInput = z.object({
  manifestPath: z
    .string()
    .describe('Absolute path to a crawl manifest produced with ImageExtractor enabled (the default).'),

  topOffenders: z
    .number().int().min(1).max(100)
    .default(25)
    .describe('How many worst-offender pages to return per issue category.'),
});

// ── Types ──────────────────────────────────────────────────────────────────────

interface PageImageSummary {
  url:            string;
  title:          string;
  totalImages:    number;
  missingAlt:     number;
  decorative:     number;
  missingDims:    number;  // images missing both width and height
  lazyLoaded:     number;
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `analyze_images` tool on the given McpServer.
 *
 * Analyses image usage and alt text coverage across the entire crawl:
 *
 * Coverage
 *   - Site-wide totals: total images, missing alt, decorative, present, lazy-loaded
 *   - Coverage rate: % of content images with descriptive alt text
 *
 * Alt text issues
 *   - Pages with the most missing alt images (ranked by missing count)
 *   - Pages where every image is missing alt (complete coverage failures)
 *
 * Layout stability (CLS risk)
 *   - Pages with images missing declared width/height attributes
 *   - Cumulative Layout Shift is a Core Web Vital that affects ranking
 *
 * Lazy loading
 *   - Adoption rate across the site
 */
export function registerAnalyzeImages(server: McpServer): void {
  server.tool(
    'analyze_images',

    'Analyse image usage and alt text coverage across a crawl manifest. Reports site-wide ' +
    'alt text coverage rates, pages with the most missing-alt images, images without declared ' +
    'width/height (CLS risk), and lazy loading adoption. ' +
    'Requires a manifest crawled with ImageExtractor enabled (the default).',

    AnalyzeImagesInput.shape,

    async (args) => {
      const input = AnalyzeImagesInput.parse(args);

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
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'analyze_images requires a crawl manifest.' }) }],
          isError: true,
        };
      }

      const hasImageData = manifest.pages.some(p => p['mcp.images']);
      if (!hasImageData) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No image data found in manifest. Re-crawl with ImageExtractor enabled (the default).',
              extractors: manifest.meta.extractors,
            }),
          }],
          isError: true,
        };
      }

      // ── Site-wide accumulators ─────────────────────────────────────────
      let siteTotalImages  = 0;
      let siteMissing      = 0;
      let siteDecorative   = 0;
      let sitePresent      = 0;
      let siteLazy         = 0;
      let siteMissingDims  = 0;

      const pageSummaries: PageImageSummary[] = [];
      let totalPages = 0;

      for (const page of manifest.pages) {
        if (page.isDuplicate) continue;
        totalPages++;

        const images = page['mcp.images'] as ImageData | undefined;
        const seo    = page['mcp.seo']    as SeoData   | undefined;

        if (!images || images.counts.total === 0) continue;

        const missingDims = images.images.filter(
          img => img.width === undefined && img.height === undefined,
        ).length;

        siteTotalImages += images.counts.total;
        siteMissing     += images.counts.missing;
        siteDecorative  += images.counts.decorative;
        sitePresent     += images.counts.present;
        siteLazy        += images.counts.lazyLoaded;
        siteMissingDims += missingDims;

        pageSummaries.push({
          url:         page.url,
          title:       seo?.title ?? '',
          totalImages: images.counts.total,
          missingAlt:  images.counts.missing,
          decorative:  images.counts.decorative,
          missingDims,
          lazyLoaded:  images.counts.lazyLoaded,
        });
      }

      // ── Ranked lists ───────────────────────────────────────────────────
      const worstMissingAlt = [...pageSummaries]
        .filter(p => p.missingAlt > 0)
        .sort((a, b) => b.missingAlt - a.missingAlt || b.totalImages - a.totalImages)
        .slice(0, input.topOffenders);

      const completeFailures = pageSummaries
        .filter(p => p.missingAlt === p.totalImages && p.totalImages > 0)
        .sort((a, b) => b.totalImages - a.totalImages);

      const worstClsRisk = [...pageSummaries]
        .filter(p => p.missingDims > 0)
        .sort((a, b) => b.missingDims - a.missingDims)
        .slice(0, input.topOffenders);

      // Coverage rate: of non-decorative images, what % have descriptive alt?
      const contentImages   = siteTotalImages - siteDecorative;
      const coverageRate    = contentImages > 0
        ? Math.round((sitePresent / contentImages) * 100)
        : 100;

      const lazyAdoptionRate = siteTotalImages > 0
        ? Math.round((siteLazy / siteTotalImages) * 100)
        : 0;

      // ── Response ──────────────────────────────────────────────────────
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              manifestPath:  input.manifestPath,
              seedUrl:       manifest.meta.seedUrl,
              crawledAt:     manifest.meta.createdAt,
              pagesAnalyzed: totalPages,
              pagesWithImages: pageSummaries.length,

              sitewide: {
                totalImages:        siteTotalImages,
                missingAlt:         siteMissing,
                decorativeAlt:      siteDecorative,
                presentAlt:         sitePresent,
                contentImageCoverageRate: `${coverageRate}%`,
                missingDimensions:  siteMissingDims,
                lazyLoaded:         siteLazy,
                lazyAdoptionRate:   `${lazyAdoptionRate}%`,
              },

              issues: {
                pagesWithMissingAlt:      worstMissingAlt.length,
                pagesWithCompleteFailure: completeFailures.length,
                pagesWithClsRisk:         worstClsRisk.length,
              },
            },

            worstMissingAlt,
            completeAltFailures: completeFailures,
            worstClsRisk,
          }, null, 2),
        }],
      };
    },
  );
}
