import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CrawlConfig,
  CrawlEngine,
  HttpClientBackend,
  SsrfPolicy,
  saveManifest,
  loadManifest,
  isCrawlManifest,
  type CrawlManifest,
  type CrawlManifestPage,
} from '@crawl/engine';
import {
  SeoExtractor,
  LinkExtractor,
  MetaExtractor,
  HeadingExtractor,
  ImageExtractor,
  SchemaExtractor,
} from '@crawl/extractors';

/**
 * Regression test for finding A: registerCrawlTool's manifest builder used
 * to instantiate all six extractors but only ever attach 'mcp.seo' and
 * 'mcp.links' to saved pages, so analyze_meta/analyze_headings/analyze_images
 * /analyze_schema registered fine and passed smoke tests while returning "no
 * data found" against every real manifest. This exercises the same
 * page-building shape crawl.ts uses (six extractors → six mcp.* keys → full
 * extractors list in meta) against a real HTTP fixture, then round-trips the
 * saved manifest through disk.
 */
describe('crawl manifest persistence (six extractors)', () => {
  let server: Server;
  let baseUrl: string;
  let tmpRoot: string;
  let prevScratch: string | undefined;

  const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Fixture Page</title>
  <meta name="description" content="A fixture page for manifest persistence tests.">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Article","headline":"Fixture Page"}
  </script>
</head>
<body>
  <h1>Fixture Heading</h1>
  <h2>Section</h2>
  <img src="/photo.jpg" alt="A fixture photo">
  <a href="/other">Other page</a>
  <p>Enough body text to give the extractors something to chew on.</p>
</body>
</html>`;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crawl-manifest-test-'));
    prevScratch = process.env['SCRATCH_DIR'];
    process.env['SCRATCH_DIR'] = tmpRoot;

    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind fixture server');
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    if (prevScratch === undefined) delete process.env['SCRATCH_DIR'];
    else process.env['SCRATCH_DIR'] = prevScratch;
    rmSync(tmpRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('persists all six extractor outputs and a full extractors list', async () => {
    const seoExtractor     = new SeoExtractor();
    const linkExtractor    = new LinkExtractor();
    const metaExtractor    = new MetaExtractor();
    const headingExtractor = new HeadingExtractor();
    const imageExtractor   = new ImageExtractor();
    const schemaExtractor  = new SchemaExtractor();

    const config = CrawlConfig.builder(baseUrl)
      .maxDepth(0)
      .ssrfPolicy(SsrfPolicy.ALLOW_ALL) // fixture is a loopback server we control
      .build();

    const backend = HttpClientBackend.create(SsrfPolicy.ALLOW_ALL);
    const engine  = new CrawlEngine(config, backend, [
      seoExtractor,
      linkExtractor,
      metaExtractor,
      headingExtractor,
      imageExtractor,
      schemaExtractor,
    ]);

    const pages: CrawlManifestPage[] = [];
    const crawlIter = engine.crawl();
    for await (const snap of crawlIter) {
      const page: CrawlManifestPage = {
        url:         snap.url,
        statusCode:  snap.statusCode,
        depth:       snap.depth,
        isDuplicate: snap.isDuplicate,
      };

      const seo      = snap.extraction(seoExtractor);
      const links     = snap.extraction(linkExtractor);
      const meta      = snap.extraction(metaExtractor);
      const headings  = snap.extraction(headingExtractor);
      const images    = snap.extraction(imageExtractor);
      const schema    = snap.extraction(schemaExtractor);

      if (seo)      page['mcp.seo']      = seo;
      if (links)    page['mcp.links']    = links;
      if (meta)     page['mcp.meta']     = meta;
      if (headings) page['mcp.headings'] = headings;
      if (images)   page['mcp.images']   = images;
      if (schema)   page['mcp.schema']   = schema;

      pages.push(page);
    }
    const summary = await crawlIter.summary();

    const manifest: CrawlManifest = {
      meta: {
        source:        'crawl',
        seedUrl:       config.seedUrl,
        createdAt:     new Date().toISOString(),
        pagesCaptured: summary.pagesCaptured,
        pagesIgnored:  summary.pagesIgnored,
        extractors: [
          seoExtractor.id(),
          linkExtractor.id(),
          metaExtractor.id(),
          headingExtractor.id(),
          imageExtractor.id(),
          schemaExtractor.id(),
        ],
        bypassBot:     false,
        durationMs:    summary.durationMs,
        stoppedReason: 'drained',
      },
      pages,
      failures: [],
    };

    expect(manifest.meta.extractors.length).toBe(6);

    const manifestPath = 'crawl-manifest-persistence.json';
    saveManifest(manifestPath, manifest);

    const loaded = loadManifest(manifestPath);
    expect(isCrawlManifest(loaded)).toBe(true);
    if (!isCrawlManifest(loaded)) return;

    expect(loaded.meta.extractors.length).toBe(6);
    expect(loaded.pages.length).toBeGreaterThan(0);

    const firstPage = loaded.pages[0]!;
    expect(firstPage['mcp.seo']).toBeDefined();
    expect(firstPage['mcp.links']).toBeDefined();
    expect(firstPage['mcp.meta']).toBeDefined();
    expect(firstPage['mcp.headings']).toBeDefined();
    expect(firstPage['mcp.images']).toBeDefined();
    expect(firstPage['mcp.schema']).toBeDefined();
  });
});
