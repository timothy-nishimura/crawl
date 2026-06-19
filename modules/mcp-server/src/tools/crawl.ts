import { z }                     from 'zod';
import type { McpServer }        from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CrawlConfig,
  CrawlEngine,
  HttpClientBackend,
  PlaywrightFetchBackend,
  SsrfPolicy,
  Security,
} from '@crawl/engine';
import { isSearchEngine, isJsGated } from '../lib/domain-hints.js';
import type { FetchBackend }     from '@crawl/engine';
import { FetchRequest, FetchResult } from '@crawl/engine';
import { SeoExtractor }          from '../extractors/SeoExtractor.js';
import type { SeoData }          from '../extractors/SeoExtractor.js';
import { LinkExtractor }         from '../extractors/LinkExtractor.js';
import type { LinkData }         from '../extractors/LinkExtractor.js';
import { MetaExtractor }         from '../extractors/MetaExtractor.js';
import { HeadingExtractor }      from '../extractors/HeadingExtractor.js';
import { ImageExtractor }        from '../extractors/ImageExtractor.js';
import { SchemaExtractor }       from '../extractors/SchemaExtractor.js';
import { TlsFetchBackend }       from '../backends/TlsFetchBackend.js';
import {
  saveManifest,
  type CrawlManifest,
  type CrawlManifestPage,
} from '../types/CrawlManifest.js';
// ── Shared extractor instances (stateless — safe to reuse across requests) ────
const seoExtractor     = new SeoExtractor();
const linkExtractor    = new LinkExtractor();
const metaExtractor    = new MetaExtractor();
const headingExtractor = new HeadingExtractor();
const imageExtractor   = new ImageExtractor();
const schemaExtractor  = new SchemaExtractor();

// ── Input schema ───────────────────────────────────────────────────────────────

const CrawlInput = z.object({
  url: z
    .string()
    .url()
    .describe('Seed URL to start crawling from (must be http:// or https://)'),

  maxDepth: z
    .number().int().min(0).max(10)
    .default(2)
    .describe(
      'Maximum link depth to follow. 0 = seed page only; 1 = seed + direct links; etc.',
    ),

  maxPages: z
    .number().int().min(1).max(500)
    .default(50)
    .describe('Hard cap on the number of pages to capture. Stops the crawl early if reached.'),

  timeLimitSeconds: z
    .number().int().min(10).max(300)
    .default(60)
    .describe('Wall-clock time limit for the entire crawl in seconds.'),

  includePattern: z
    .string()
    .optional()
    .describe(
      'Only crawl URLs that contain this substring (e.g. "/docs/" to restrict to a docs section).',
    ),

  excludePattern: z
    .string()
    .optional()
    .describe(
      'Skip any URL containing this substring (e.g. "/blog/" to avoid blog posts).',
    ),

  crawlSubdomains: z
    .boolean()
    .default(false)
    .describe('If true, follow links to subdomains of the seed domain.'),

  respectRobotsTxt: z
    .boolean()
    .default(true)
    .describe('If true, honour robots.txt crawl directives (strongly recommended).'),

  bypassBot: z
    .boolean()
    .default(false)
    .describe(
      'If true, use a Chrome TLS fingerprint for all requests. ' +
      'Bypasses Cloudflare and similar bot-detection walls that block Node.js. ' +
      'Slower than the default backend — only enable when the site blocks normal crawls.',
    ),

  saveToFile: z
    .string()
    .optional()
    .describe(
      'Absolute path to save the full crawl manifest as JSON. ' +
      'When set, the tool writes all page data to this file and returns only a ' +
      'lightweight summary (~20 tokens) instead of the full page list. ' +
      'Use search_manifest to query the saved file later. ' +
      'Strongly recommended for crawls of more than 20 pages.',
    ),

  renderJs: z
    .boolean()
    .default(false)
    .describe(
      'If true, use a headless browser (Playwright) to render the page. ' +
      'Essential for React/Next.js sites and JS-heavy communities. ' +
      'The slowest backend — use only when necessary.',
    ),
});

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `crawl` tool on the given McpServer.
 *
 * Two output modes:
 *
 *   Inline mode (default):  returns full page metadata in the MCP response.
 *                            Fine for small crawls (<20 pages) when you need
 *                            the data directly in context.
 *
 *   File mode (saveToFile): writes a CrawlManifest JSON to disk and returns
 *                            only {savedTo, summary}.  Use search_manifest to
 *                            query specific slices without loading everything
 *                            into context.  Strongly recommended for larger crawls.
 *
 * Typical workflows:
 *   Small exploration  → crawl(url, maxPages=10) inline
 *   Site audit         → crawl(url, saveToFile=path) → search_manifest(path, query)
 *   Content pipeline   → parse_sitemap + search_manifest + fetch_page
 */
export function registerCrawlTool(server: McpServer): void {
  server.tool(
    'crawl',

    'Systematically crawl a website, following internal links up to a specified depth. ' +
    'In inline mode (default) returns structured metadata for every page. ' +
    'In file mode (saveToFile) writes a manifest to disk and returns only a summary — ' +
    'use search_manifest to query the file. File mode is strongly recommended for >20 pages.',

    CrawlInput.shape,

    async (args) => {
      const input = CrawlInput.parse(args);

      // ── Pre-flight: JS-gated warning ────────────────────────────────────
      const toolNotes: string[] = [];
      if (isJsGated(input.url) && !input.renderJs) {
        toolNotes.push(`[Warning] ${new URL(input.url).hostname} usually requires JS rendering. Results may be incomplete without renderJs: true.`);
      }

      // ── Build config ─────────────────────────────────────────────────────
      const renderJs = input.renderJs;
      const builder = CrawlConfig.builder(input.url)
        .maxDepth(input.maxDepth)
        .crawlSubdomains(input.crawlSubdomains)
        .respectRobotsTxt(input.respectRobotsTxt)
        .ssrfPolicy(SsrfPolicy.BLOCK_PRIVATE)
        .workers(renderJs ? 2 : 4) // Lower concurrency for browser-heavy crawls
        .requestDelayMs(renderJs ? 1000 : 250)
        .renderJs(renderJs);

      if (input.includePattern) builder.includePattern(input.includePattern);
      if (input.excludePattern) builder.excludePattern(input.excludePattern);

      const config = builder.build();

      // ── Backend selection with Cloudflare auto-detection ──────────────────
      let backend: FetchBackend;
      let autoBypass = false;

      if (input.renderJs) {
        try {
          backend = await PlaywrightFetchBackend.create({ headless: true });
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'renderJs requested but Playwright backend unavailable: ' + String(err),
                hint:  'Ensure playwright is installed and browsers are downloaded.',
              }),
            }],
            isError: true,
          };
        }
      } else if (input.bypassBot) {
        try {
          backend = await TlsFetchBackend.create();
          autoBypass = true;
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'bypassBot requested but TLS backend unavailable: ' + String(err),
                hint:  'Ensure got-scraping is installed in the Docker image.',
              }),
            }],
            isError: true,
          };
        }
      } else {
        const probeBackend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
        let needsBypass = false;
        try {
          const probeReq    = FetchRequest.builder(input.url).timeoutMs(10_000).build();
          const probeResult = await probeBackend.fetch(probeReq);
          if (
            probeResult.statusCode === 403 &&
            FetchResult.header(probeResult, 'cf-ray') !== undefined
          ) {
            needsBypass = true;
          }
        } finally {
          await probeBackend.close();
        }

        if (needsBypass) {
          try {
            backend    = await TlsFetchBackend.create();
            autoBypass = true;
          } catch {
            backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
          }
        } else {
          backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
        }
      }

      const engine = new CrawlEngine(config, backend, [
        seoExtractor,
        linkExtractor,
        metaExtractor,
        headingExtractor,
        imageExtractor,
        schemaExtractor,
      ]);

      // ── Time limit ────────────────────────────────────────────────────────
      let timedOut = false;
      const timer  = setTimeout(() => {
        timedOut = true;
        engine.stop();
      }, input.timeLimitSeconds * 1_000);

      // ── Crawl ─────────────────────────────────────────────────────────────
      const pages: CrawlManifestPage[] = [];
      const crawlIter = engine.crawl();

      try {
        for await (const snap of crawlIter) {
          const seo   = snap.extraction(seoExtractor)  as SeoData  | null;
          const links = snap.extraction(linkExtractor) as LinkData | null;

          const page: CrawlManifestPage = {
            url:         snap.url,
            statusCode:  snap.statusCode,
            depth:       snap.depth,
            isDuplicate: snap.isDuplicate,
          };

          if (seo)   page['mcp.seo']   = seo;
          if (links) page['mcp.links'] = links;

          pages.push(page);

          if (pages.length >= input.maxPages) {
            engine.stop();
            break;
          }
        }
      } finally {
        clearTimeout(timer);
        await backend.close();
      }

      const summary = await crawlIter.summary();

      const stoppedReason = timedOut
        ? 'time_limit'
        : !summary.completedNaturally
        ? 'max_pages'
        : 'drained';

      // ── File mode ─────────────────────────────────────────────────────────
      if (input.saveToFile) {
        const manifest: CrawlManifest = {
          meta: {
            source:        'crawl',
            seedUrl:       config.seedUrl,
            createdAt:     new Date().toISOString(),
            pagesCaptured: summary.pagesCaptured,
            pagesIgnored:  summary.pagesIgnored,
            extractors:    [seoExtractor.id(), linkExtractor.id()],
            bypassBot:     autoBypass,
            durationMs:    summary.durationMs,
            stoppedReason,
          },
          pages,
          failures: [],   // MCP server crawls don't persist failures — log-level only
        };

        try {
          saveManifest(input.saveToFile, manifest);
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Failed to write manifest to ${input.saveToFile}: ${String(err)}`,
              }),
            }],
            isError: true,
          };
        }

        const safePath = Security.sandboxPath(input.saveToFile);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              savedTo:      safePath,
              summary: {
                seedUrl:       config.seedUrl,
                bypassBot:     autoBypass,
                pagesCaptured: summary.pagesCaptured,
                pagesIgnored:  summary.pagesIgnored,
                durationMs:    summary.durationMs,
                stoppedReason,
                ...(toolNotes.length > 0 && { notes: toolNotes }),
              },
            }),
          }],
        };
      }

      // ── Inline mode ───────────────────────────────────────────────────────
      const inlinePages = pages.map(p => {
        const seo = p['mcp.seo'] as SeoData | undefined;
        return {
          url:         p.url,
          statusCode:  p.statusCode,
          depth:       p.depth,
          isDuplicate: p.isDuplicate,
          title:       seo?.title       ?? '',
          description: seo?.description ?? '',
          h1:          seo?.h1          ?? '',
          wordCount:   seo?.wordCount   ?? 0,
          excerpt:     seo?.excerpt     ?? '',
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: {
              seedUrl:            config.seedUrl,
              bypassBot:          autoBypass,
              pagesCaptured:      summary.pagesCaptured,
              pagesIgnored:       summary.pagesIgnored,
              ignoredBreakdown:   summary.ignoredBreakdown,
              durationMs:         summary.durationMs,
              completedNaturally: summary.completedNaturally,
              stoppedReason,
              ...(toolNotes.length > 0 && { notes: toolNotes }),
            },
            pages: inlinePages,
          }, null, 2),
        }],
      };
    },
  );
}
