/**
 * Integration tests for CrawlEngine using an in-memory MockFetchBackend.
 *
 * These tests verify end-to-end crawl behaviour: link extraction, depth
 * limiting, redirect handling, robots.txt compliance, body deduplication,
 * and observer callbacks — without touching the network.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { CrawlEngine }    from '../CrawlEngine.js';
import { CrawlConfig }    from '../CrawlConfig.js';
import type { FetchBackend } from '../FetchBackend.js';
import type { FetchRequest } from '../FetchRequest.js';
import { FetchResult }    from '../FetchResult.js';
import { IgnoreReason }   from '../CrawlSummary.js';
import type { PageSnapshot } from '../PageSnapshot.js';
import type { CrawlObserver } from '../CrawlObserver.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function html(links: string[] = [], body = ''): Uint8Array {
  const hrefs = links.map(l => `<a href="${l}">link</a>`).join('');
  return enc.encode(`<html><body>${hrefs}${body}</body></html>`);
}

function makeResult(url: string, opts: {
  status?:      number;
  links?:       string[];
  body?:        Uint8Array;
  contentType?: string;
  headers?:     Record<string, string[]>;
} = {}): FetchResult {
  const body = opts.body ?? html(opts.links ?? []);
  return FetchResult.builder(url)
    .finalUri(url)
    .statusCode(opts.status ?? 200)
    .contentType(opts.contentType ?? 'text/html')
    .charset('utf-8')
    .body(body)
    .responseHeaders(opts.headers ?? {})
    .build();
}

function redirectResult(url: string, location: string, status = 301): FetchResult {
  return FetchResult.builder(url)
    .finalUri(url)
    .statusCode(status)
    .responseHeaders({ location: [location] })
    .build();
}

function robotsResult(url: string, content: string): FetchResult {
  return FetchResult.builder(url)
    .finalUri(url)
    .statusCode(200)
    .contentType('text/plain')
    .body(enc.encode(content))
    .build();
}

/**
 * A deterministic in-memory FetchBackend.
 * Unregistered URLs return a 404 by default.
 */
class MockBackend implements FetchBackend {
  readonly fetchLog: string[] = [];
  private readonly map: Map<string, FetchResult>;

  constructor(entries: Record<string, FetchResult>) {
    this.map = new Map(Object.entries(entries));
  }

  async fetch(req: FetchRequest): Promise<FetchResult> {
    this.fetchLog.push(req.uri);
    return (
      this.map.get(req.uri) ??
      FetchResult.builder(req.uri).finalUri(req.uri).statusCode(404).build()
    );
  }

  async close(): Promise<void> { /* no-op for in-memory backend */ }
}

/** Build a CrawlConfig with test-friendly defaults. */
function testConfig(
  seed: string,
  overrides: (b: CrawlConfig.Builder) => CrawlConfig.Builder = b => b,
): CrawlConfig {
  return overrides(
    CrawlConfig.builder(seed)
      .requestDelayMs(0)   // no artificial delay in tests
      .workers(1)
      .respectRobotsTxt(false)
      .seedFromSitemap(false),
  ).build();
}

/** Collect all PageSnapshots from a crawl into an array. */
async function collectSnapshots(
  config: CrawlConfig,
  backend: FetchBackend,
  extractors = [],
  observer: CrawlObserver = {},
): Promise<PageSnapshot[]> {
  const engine = new CrawlEngine(config, backend, extractors, observer);
  const snapshots: PageSnapshot[] = [];
  for await (const snap of engine.crawl()) {
    snapshots.push(snap);
  }
  return snapshots;
}

// ── Basic crawl ───────────────────────────────────────────────────────────────

describe('CrawlEngine — basic crawl', () => {

  it('fetches the seed URL and captures a snapshot', async () => {
    const backend = new MockBackend({
      'https://example.com': makeResult('https://example.com'),
    });
    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);

    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.url).toBe('https://example.com');
    expect(snaps[0]!.statusCode).toBe(200);
    expect(snaps[0]!.isOk).toBe(true);
  });

  it('follows links and fetches multiple pages', async () => {
    const backend = new MockBackend({
      'https://example.com':       makeResult('https://example.com', { links: ['/about', '/blog'] }),
      'https://example.com/about': makeResult('https://example.com/about'),
      'https://example.com/blog':  makeResult('https://example.com/blog'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const urls = snaps.map(s => s.url).sort();

    expect(urls).toEqual([
      'https://example.com',
      'https://example.com/about',
      'https://example.com/blog',
    ]);
  });

  it('does not visit out-of-scope external links', async () => {
    const backend = new MockBackend({
      'https://example.com': makeResult('https://example.com', {
        links: ['/internal', 'https://other.com/external'],
      }),
      'https://example.com/internal': makeResult('https://example.com/internal'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const urls = snaps.map(s => s.url);

    expect(urls).toContain('https://example.com/internal');
    expect(urls).not.toContain('https://other.com/external');
  });

  it('respects maxDepth — does not fetch pages beyond the limit', async () => {
    const backend = new MockBackend({
      'https://example.com':       makeResult('https://example.com', { links: ['/level1'] }),
      'https://example.com/level1': makeResult('https://example.com/level1', { links: ['/level2'] }),
      'https://example.com/level2': makeResult('https://example.com/level2'),
    });

    const snaps = await collectSnapshots(
      testConfig('https://example.com', b => b.maxDepth(1)),
      backend,
    );
    const urls = snaps.map(s => s.url);

    expect(urls).toContain('https://example.com');
    expect(urls).toContain('https://example.com/level1');
    expect(urls).not.toContain('https://example.com/level2');
  });

  it('does not visit the same URL twice', async () => {
    const backend = new MockBackend({
      // Both pages link back to the seed and to each other
      'https://example.com':       makeResult('https://example.com', { links: ['/a'] }),
      'https://example.com/a':     makeResult('https://example.com/a',  { links: ['/', '/a'] }),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const urls = snaps.map(s => s.url);

    expect(urls.filter(u => u === 'https://example.com')).toHaveLength(1);
    expect(urls.filter(u => u === 'https://example.com/a')).toHaveLength(1);
  });
});

// ── Redirect handling ─────────────────────────────────────────────────────────

describe('CrawlEngine — redirect handling (security fix)', () => {

  it('enqueues the Location URL and does not capture a snapshot for 3xx', async () => {
    const backend = new MockBackend({
      'https://example.com':           makeResult('https://example.com', { links: ['/old'] }),
      'https://example.com/old':       redirectResult('https://example.com/old', '/new'),
      'https://example.com/new':       makeResult('https://example.com/new'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const urls = snaps.map(s => s.url);

    // /old is a redirect — no snapshot
    expect(urls).not.toContain('https://example.com/old');
    // /new is the redirect target — should be captured
    expect(urls).toContain('https://example.com/new');
  });

  it('counts redirects in the REDIRECT ignore bucket', async () => {
    const backend = new MockBackend({
      'https://example.com': redirectResult('https://example.com', '/new'),
      'https://example.com/new': makeResult('https://example.com/new'),
    });

    const config = testConfig('https://example.com');
    const engine = new CrawlEngine(config, backend, []);
    for await (const _ of engine.crawl()) { /* drain */ }
    const summary = await engine.crawl().summary();

    expect(summary.ignoredBreakdown[IgnoreReason.REDIRECT]).toBeGreaterThanOrEqual(1);
  });

  it('redirect target is subject to scope check — out-of-scope location is dropped', async () => {
    const backend = new MockBackend({
      'https://example.com':
        redirectResult('https://example.com', 'https://other.com/page'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    // The redirect target is out of scope; the crawl should end with 0 captures
    expect(snaps).toHaveLength(0);
  });

  it('handles redirect chains correctly via the frontier', async () => {
    const backend = new MockBackend({
      'https://example.com':           makeResult('https://example.com', { links: ['/step1'] }),
      'https://example.com/step1':     redirectResult('https://example.com/step1', '/step2'),
      'https://example.com/step2':     redirectResult('https://example.com/step2', '/final'),
      'https://example.com/final':     makeResult('https://example.com/final'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const urls = snaps.map(s => s.url);

    expect(urls).not.toContain('https://example.com/step1');
    expect(urls).not.toContain('https://example.com/step2');
    expect(urls).toContain('https://example.com/final');
  });
});

// ── Body deduplication ────────────────────────────────────────────────────────

describe('CrawlEngine — body deduplication', () => {

  it('marks a second page with identical body as duplicate', async () => {
    // /page-a and /page-b serve identical content — the second one fetched
    // should be flagged isDuplicate by BodyDeduplicator.
    const sharedBody = enc.encode('<html><body>identical content</body></html>');

    const dupResult = (u: string) =>
      FetchResult.builder(u)
        .finalUri(u)
        .statusCode(200)
        .contentType('text/html')
        .charset('utf-8')
        .body(sharedBody)
        .build();

    const backend = new MockBackend({
      'https://example.com':         makeResult('https://example.com', { links: ['/page-a', '/page-b'] }),
      'https://example.com/page-a':  dupResult('https://example.com/page-a'),
      'https://example.com/page-b':  dupResult('https://example.com/page-b'),
    });

    const snaps = await collectSnapshots(testConfig('https://example.com'), backend);
    const dupSnaps = snaps.filter(s => s.isDuplicate);
    // The second of the two identical pages must be marked duplicate
    expect(dupSnaps.length).toBeGreaterThanOrEqual(1);
  });
});

// ── robots.txt ────────────────────────────────────────────────────────────────

describe('CrawlEngine — robots.txt compliance', () => {

  it('skips disallowed URLs when respectRobotsTxt is true', async () => {
    const backend = new MockBackend({
      'https://example.com/robots.txt':
        robotsResult('https://example.com/robots.txt', 'User-agent: *\nDisallow: /secret/\n'),
      'https://example.com':
        makeResult('https://example.com', { links: ['/secret/page', '/public'] }),
      'https://example.com/secret/page':
        makeResult('https://example.com/secret/page'),
      'https://example.com/public':
        makeResult('https://example.com/public'),
    });

    // Override to re-enable robots.txt
    const config = testConfig('https://example.com', b => b.respectRobotsTxt(true));
    const snaps = await collectSnapshots(config, backend);
    const urls = snaps.map(s => s.url);

    expect(urls).toContain('https://example.com/public');
    expect(urls).not.toContain('https://example.com/secret/page');
  });

  it('allows all URLs when robots.txt returns 404', async () => {
    const backend = new MockBackend({
      // robots.txt is absent — 404 returned by MockBackend default
      'https://example.com':
        makeResult('https://example.com', { links: ['/any-page'] }),
      'https://example.com/any-page':
        makeResult('https://example.com/any-page'),
    });

    const config = testConfig('https://example.com', b => b.respectRobotsTxt(true));
    const snaps = await collectSnapshots(config, backend);
    const urls = snaps.map(s => s.url);

    expect(urls).toContain('https://example.com/any-page');
  });
});

// ── Observer callbacks ────────────────────────────────────────────────────────

describe('CrawlEngine — observer callbacks', () => {

  it('calls onCrawlStarted once with the seed URL', async () => {
    const onCrawlStarted = jest.fn();
    const backend = new MockBackend({
      'https://example.com': makeResult('https://example.com'),
    });

    await collectSnapshots(
      testConfig('https://example.com'),
      backend,
      [],
      { onCrawlStarted },
    );

    expect(onCrawlStarted).toHaveBeenCalledTimes(1);
    expect(onCrawlStarted).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('calls onCrawlCompleted with a summary after the crawl', async () => {
    const onCrawlCompleted = jest.fn();
    const backend = new MockBackend({
      'https://example.com': makeResult('https://example.com'),
    });

    await collectSnapshots(testConfig('https://example.com'), backend, [], { onCrawlCompleted });

    expect(onCrawlCompleted).toHaveBeenCalledTimes(1);
    const summary = (onCrawlCompleted.mock.calls[0] as [unknown])[0] as { pagesCaptured: number };
    expect(summary.pagesCaptured).toBe(1);
  });

  it('calls onPageCaptured for each captured page', async () => {
    const onPageCaptured = jest.fn();
    const backend = new MockBackend({
      'https://example.com':       makeResult('https://example.com', { links: ['/a'] }),
      'https://example.com/a':     makeResult('https://example.com/a'),
    });

    await collectSnapshots(testConfig('https://example.com'), backend, [], { onPageCaptured });

    expect(onPageCaptured).toHaveBeenCalledTimes(2);
  });
});

// ── CrawlSummary ──────────────────────────────────────────────────────────────

describe('CrawlEngine — crawl summary', () => {

  it('summary reflects captured count', async () => {
    const backend = new MockBackend({
      'https://example.com':       makeResult('https://example.com', { links: ['/a', '/b'] }),
      'https://example.com/a':     makeResult('https://example.com/a'),
      'https://example.com/b':     makeResult('https://example.com/b'),
    });

    const engine = new CrawlEngine(testConfig('https://example.com'), backend, []);
    const crawl  = engine.crawl();
    for await (const _ of crawl) { /* drain */ }
    const summary = await crawl.summary();

    expect(summary.pagesCaptured).toBe(3);
    expect(summary.completedNaturally).toBe(true);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('summary counts MAX_DEPTH ignores in the breakdown', async () => {
    const backend = new MockBackend({
      'https://example.com':       makeResult('https://example.com', { links: ['/deep'] }),
      'https://example.com/deep':  makeResult('https://example.com/deep'),
    });

    const engine = new CrawlEngine(
      testConfig('https://example.com', b => b.maxDepth(0)),
      backend,
      [],
    );
    const crawl = engine.crawl();
    for await (const _ of crawl) { /* drain */ }
    const summary = await crawl.summary();

    expect(summary.ignoredBreakdown[IgnoreReason.MAX_DEPTH]).toBeGreaterThanOrEqual(1);
    expect(summary.buriedUrls.has('https://example.com/deep')).toBe(true);
  });

  it('stop() causes completedNaturally to be false', async () => {
    const backend = new MockBackend({
      'https://example.com': makeResult('https://example.com', { links: ['/a', '/b', '/c'] }),
      'https://example.com/a': makeResult('https://example.com/a'),
      'https://example.com/b': makeResult('https://example.com/b'),
      'https://example.com/c': makeResult('https://example.com/c'),
    });

    const engine = new CrawlEngine(testConfig('https://example.com'), backend, []);
    const crawl  = engine.crawl();

    let count = 0;
    for await (const _ of crawl) {
      count++;
      if (count === 1) engine.stop();
    }

    const summary = await crawl.summary();
    expect(summary.completedNaturally).toBe(false);
  });
});
