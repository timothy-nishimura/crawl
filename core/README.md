# @crawl/engine

A robust, plug-and-play TypeScript web crawler engine with zero framework dependencies. Designed for high performance, concurrency, and safety out-of-the-box.

## Features

- **Concurrent Dispatch**: Explicit promise pool concurrency to maximize I/O throughput.
- **Smart Rate Limiting**: Strict per-host delay enforcement with jitter to prevent server bans.
- **Auto-Retries & Backoff**: Built-in 429 Too Many Requests handling with exponential backoff.
- **Robots.txt Compliance**: Automatic caching and evaluation of `robots.txt` rules per host.
- **Sitemap Seeding**: Optionally bootstrap your crawl frontier automatically from a domain's `sitemap.xml`.
- **SSRF Protection**: Pre-flight DNS resolution prevents Server-Side Request Forgery against internal networks.
- **Body Deduplication**: Fast SHA-256 hashing detects and skips duplicate content bodies.
- **Custom Extractors**: Implement the `Extractor` interface to easily parse structured data from pages.

## Installation

```bash
npm install @crawl/engine
```

## Quick Start

```typescript
import { CrawlEngine } from '@crawl/engine';
import { CrawlConfig } from '@crawl/engine/CrawlConfig';
import { Extractor } from '@crawl/engine/Extractor';
import { HttpClientBackend } from '@crawl/engine/HttpClientBackend';

// 1. Configure your crawl session
const config = CrawlConfig.builder('https://example.com')
  .maxDepth(3)
  .workers(8)
  .requestDelayMs(1000)
  .respectRobotsTxt(true)
  .build();

// 2. Initialize the backend
const backend = HttpClientBackend.create();

// 3. Define an extractor (optional)
const titleExtractor: Extractor<string> = {
  id: () => 'title',
  extract: (page) => page.document ? page.document('title').text() : null
};

// 4. Start crawling!
const engine = new CrawlEngine(config, backend, [titleExtractor]);

async function run() {
  for await (const snapshot of engine.crawl()) {
    console.log(`Crawled [${snapshot.statusCode}]: ${snapshot.url}`);
    console.log('Title:', snapshot.extractions.get('title'));
  }

  const summary = await engine.crawl().summary();
  console.log(`Finished! Captured ${summary.pagesCaptured} pages in ${summary.durationMs}ms`);
}

run();
```

## Configuration Options

`CrawlConfig.builder(seedUrl)` provides a fluent API for fine-tuning your crawl:

- `.maxDepth(number)`: Maximum link depth from the seed URL.
- `.workers(number)`: Maximum concurrent connections.
- `.requestDelayMs(number)`: Delay between requests to the *same host*.
- `.jitterPct(number)`: Randomize delays to avoid patterned scraping detection.
- `.respectRobotsTxt(boolean)`: Enforce robots.txt rules.
- `.seedFromSitemap(boolean)`: Auto-discover URLs from `/sitemap.xml`.
- `.maxBodyBytes(number)`: Truncate large response bodies to prevent memory exhaustion.
- `.includePattern(regex)` / `.excludePattern(regex)`: Restrict the crawl scope.

## Architecture

The engine uses an asynchronous loop driven by an `InMemoryFrontier`. It maintains a pool of active workers limited by your `workers` configuration. Requests to different hosts execute concurrently, while requests to the same host queue behind a delay promise chain to enforce politeness.

Under the hood, the HTTP layer is powered by `undici`, providing high performance and connection keep-alive pooling.

## Security & Red Team Audit

This engine recently underwent a rigorous red team security audit. The following critical vulnerabilities were identified and patched to ensure robust production safety:

- **Finding 1 — SSRF alt-IP bypass (Critical) ✓**
  `dns.resolve4` / `dns.resolve6` query DNS nameservers directly and throw on IP literals like `127.1` or `0x7f000001`. The old catch block treated that throw as "DNS failure → silently allow", so `undici` would then resolve `127.1` to `127.0.0.1` itself.
  *Fix:* Switched to `dns.lookup` (OS resolver via `getaddrinfo`), which normalises all IP representations — `127.1`, `0177.0.0.1`, `0x7f000001` all resolve to `127.0.0.1` before the range check. Also made the DNS-failure path fail-closed — if `dns.lookup` rejects, the request is now blocked with `SsrfError`, not silently allowed.

- **Finding 2 — SSRF TOCTOU / DNS rebinding (High) ✓**
  The old design called `SsrfGuard.check()` (one DNS lookup), then passed the original hostname to `undici.fetch()` (second DNS lookup). An attacker with a low-TTL record could return a public IP on the first lookup and `169.254.169.254` on the second.
  *Fix:* Installed a custom `undici` connector via `buildConnector`. The connector intercepts at the TCP connect callsite — the deepest possible point in the stack. It resolves the hostname once, checks the IP, and passes the resolved IP to `buildConnector`'s default TLS/TCP connect function. `undici` never performs a second lookup. For HTTPS the original hostname is forwarded as `opts.servername` (SNI) so certificate validation continues to work.

- **Finding 3 — Robots.txt + rate-limit bypass via redirects (High) ✓**
  `HttpClientBackend.fetchWithRedirects` followed `3xx` responses inline, never passing the redirect target through `RobotsCache` or `hostChains`.
  *Fix:* Removed the redirect loop entirely. `HttpClientBackend` is now a pure transport layer — it always returns the raw `3xx`. `CrawlEngine.processEntry` handles it: resolves the `Location` header against the current URL, submits it to the frontier at the same depth (a redirect is not a new crawl level), and records it as `IgnoreReason.REDIRECT`. The redirect target then flows through the normal pipeline: `robots.txt` check, per-host rate limiting, SSRF connector, dedup.

- **Finding 4 — Prototype pollution via `__proto__` response header (Medium) ✓**
  `const headers: Record<string, string[]> = {}` — a server returning `__proto__: injected` could escalate to `Object.prototype` mutation.
  *Fix:* One-line change to `Object.create(null)` — the resulting object has no prototype, so `__proto__` is treated as a plain string key with no special meaning.

*(Even with these robust protections, if you are running this crawler in a production environment and allowing users to input arbitrary `seedUrls`, it is always recommended to pair this with network-level isolation like egress filtering or a dedicated proxy.)*

## License

MIT
