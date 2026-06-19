# Crawl Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![No Maintenance Intended](https://unmaintained.tech/badge.svg)](https://unmaintained.tech/)

> Released as an open-source snapshot for the community to use and build on. This codebase is not actively maintained -- issues and pull requests are not monitored. Fork freely under the MIT license.

A production-grade, embeddable web crawler for TypeScript/Node.js. Plug it into any tool that needs to walk a site and get back a stream of rich page snapshots - SEO auditors, broken-link checkers, content monitors, competitive intelligence tools.

The engine has no UI, no storage, and no built-in reports. It produces `PageSnapshot` records as it crawls.

---

## Project layout

```
crawl-engine/
├── core/                   @crawl/engine - pure crawl engine, no interface opinions
├── modules/
│   ├── chrome-pipe/        @crawl/chrome-pipe - Chrome as fetch pipe, crawler as extraction brain
│   ├── mcp-test/           @crawl/mcp-test - minimal 3-tool MCP server for smoke testing
│   └── mcp-server/         @crawl/mcp-server - full MCP server with crawl, fetch, and analysis tools
├── configs/
│   └── examples/           reference configs (full-site-audit, content-discovery, local-seo)
├── scratch/                file output sandbox (gitignored)
```

**Dependency rule:** `core` imports nothing from this repo. `modules` import from `core` only. `configs` are data - no imports. The arrow always points inward.

---

## Quick start

**Requirements:** Node.js 20+

### Dev container (recommended for any OS)

The repo includes a `.devcontainer/` config for VS Code and Cursor. Opening the repo in a dev container gives you a Linux environment with Node 20, native module compilation, and Playwright pre-installed - no local setup required.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. In VS Code / Cursor: **Reopen in Container** (or `Dev Containers: Clone Repository in Container Volume` from the command palette)
3. `npm install` and `npx playwright install` run automatically on first build

Ports 3001 and 3002 are forwarded to localhost automatically.

### Windows setup (one-time, if developing outside the dev container)

```bash
# Allow deep node_modules paths (Windows has a 260-char path limit by default)
git config core.longpaths true

# Normalize file modes - Windows doesn't have Unix exec bits, so without this
# every file will appear modified after a Mac/Linux collaborator touches the repo
git config core.fileMode false
```

Line endings are handled automatically via `.gitattributes` (LF in the repo, CRLF on checkout for Windows). You don't need to set `core.autocrlf` manually.

### Install

```bash
npm install          # installs all workspaces from the root
```

### Build

```bash
npm run build -w core
npm run build -w modules/mcp-server
```

Or build everything at once:

```bash
npm run build --workspaces --if-present
```

### Test

```bash
npm run test -w core
```

---

## Core engine (`core/`)

### Programmatic usage

```ts
import {
  CrawlConfig,
  CrawlEngine,
  HttpClientBackend,
  SsrfPolicy,
} from '@crawl/engine';

// Use HttpClientBackend for standard sites, or PlaywrightFetchBackend for JS-rendered SPAs
const backend = new HttpClientBackend(SsrfPolicy.BLOCK_PRIVATE);

const config = CrawlConfig.builder('https://example.com')
  .maxDepth(3)
  .workers(8)
  .requestDelayMs(300)
  .build();

for await (const page of new CrawlEngine(config, backend, []).crawl()) {
  console.log(page.statusCode, page.url);
}
```

### Narrow scope with patterns

```ts
const config = CrawlConfig.builder('https://example.com/blog')
  .maxDepth(5)
  .includePattern('/blog/')    // only follow URLs containing /blog/
  .excludePattern('/tag/')     // skip tag archive pages
  .excludePattern('?page=')    // skip pagination
  .requestDelayMs(500)
  .jitterPct(20)               // ±20% randomisation per request
  .build();
```

### Custom extractor

```ts
import type { Extractor, ParsedPage } from '@crawl/engine';

interface SchemaSignals {
  jsonLdBlocks: string[];
  hasProductSchema: boolean;
}

class SchemaExtractor implements Extractor<SchemaSignals> {
  readonly id = 'schema.jsonld';

  extract(page: ParsedPage): SchemaSignals | null {
    if (!page.isHtml) return null;
    const blocks = page.$('script[type="application/ld+json"]')
      .map((_, el) => page.$(el).html() ?? '')
      .get();
    return {
      jsonLdBlocks: blocks,
      hasProductSchema: blocks.some(b => b.includes('"Product"')),
    };
  }
}

const engine = new CrawlEngine(config, backend, [new SchemaExtractor()]);

for await (const page of engine.crawl()) {
  const signals = page.extraction<SchemaSignals>('schema.jsonld');
  if (signals?.hasProductSchema) console.log('Product schema:', page.url);
}
```

### CrawlConfig reference

All settings have safe defaults for polite, scope-aware crawling. Construct via `CrawlConfig.builder(seedUrl)` - all validation happens at `build()` time.

#### Scope

| Builder method | Default | Description |
|---|---|---|
| `maxDepth(n)` | `Infinity` | Maximum link hops from seed. `0` = seed only. |
| `crawlSubdomains(bool)` | `false` | Follow links into subdomains. |
| `includePattern(str)` | _(none)_ | Only crawl URLs containing this substring. Multiple calls are OR-ed. |
| `excludePattern(str)` | _(none)_ | Skip URLs containing this substring. Takes precedence over include. |
| `checkExternalLinks(bool)` | `false` | HEAD-check external links; include their status in snapshots. |

#### Concurrency

| Builder method | Default | Description |
|---|---|---|
| `workers(n)` | `4` | Number of concurrent fetch promises. |

#### HTTP / transport

| Builder method | Default | Description |
|---|---|---|
| `timeoutMs(ms)` | `10000` | Per-request HTTP timeout. |
| `maxBodyBytes(n)` | `5242880` (5 MB) | Response body cap. Larger bodies are truncated; snapshot is still emitted. |
| `maxRedirects(n)` | `10` | Maximum redirect hops per URL. |
| `userAgent(str)` | Chrome UA | User-agent string sent with every request. |
| `renderJs(bool)` | `false` | Enable JS rendering (requires `PlaywrightFetchBackend`). |
| `postNavigationDelayMs(ms)` | `0` | Time to wait after page load before capturing DOM (useful for SPAs). |

#### Traffic shaping

| Builder method | Default | Description |
|---|---|---|
| `requestDelayMs(ms)` | `500` | Base delay between requests to the same host. `0` disables. |
| `jitterPct(pct)` | `20` | ±% randomisation applied to every delay. |
| `retryDelayMs(ms)` | `2000` | Base back-off for 429 retries (doubles each attempt). |
| `maxRetries(n)` | `5` | Maximum 429 retries before a URL is abandoned. |

#### Web standards

| Builder method | Default | Description |
|---|---|---|
| `respectRobotsTxt(bool)` | `true` | Fetch and respect `robots.txt` for every domain. |
| `seedFromSitemap(bool)` | `true` | Pre-load the frontier from `sitemap.xml`. |
| `detectDuplicates(bool)` | `true` | Flag pages whose body matches an earlier page. |
| `stripSessionParams(bool)` | `true` | Strip `PHPSESSID`, `JSESSIONID`, etc. from URLs. |

#### Security

| Builder method | Default | Description |
|---|---|---|
| `ssrfPolicy(policy)` | `BLOCK_PRIVATE` | Block requests to private/loopback IP ranges. |

---

## MCP server (`modules/mcp-server/`)

Exposes the crawl engine as tools for Claude and any MCP-compatible client.

### Start

```bash
node modules/mcp-server/dist/index.js
```

### Tools

| Tool | Description |
|---|---|
| `crawl` | Crawl a site from a seed URL. Returns a manifest of page snapshots with SEO and link data. |
| `fetch_page` | Fetch a single URL and return its SEO data, article content, and links. |
| `fetch_api` | Walk an offset-paginated JSON API and return the collected results. |
| `parse_sitemap` | Parse a sitemap.xml and return all discovered URLs. |
| `search_manifest` | Search a saved crawl manifest by keyword, URL pattern, or status code. |
| `summarize_manifest` | Return aggregate stats for a saved manifest (page count, word counts, status distribution). |
| `analyze_links` | Analyze the link graph from a manifest - internal, external, broken. |
| `analyze_meta` | Extract canonical, robots, Open Graph, and hreflang signals from a manifest. |
| `analyze_headings` | Audit heading structure (H1-H6) across a manifest for SEO issues. |
| `analyze_images` | Audit images for missing alt text and other accessibility signals. |
| `analyze_schema` | Extract and summarize JSON-LD schema blocks across a manifest. |
| `compare_manifests` | Diff two crawl manifests to surface new, removed, and changed pages. |
| `find_orphans` | Identify pages with no internal inbound links. |

### Extractors

The MCP server ships two built-in extractors registered on every crawl:

- **`SeoExtractor`** - title, meta description, H1, word count, article word count, excerpt
- **`LinkExtractor`** - internal and external links with anchor text

---

## Chrome pipe (`modules/chrome-pipe/`)

A sample MCP module that inverts the usual architecture: instead of the crawler fetching pages, Claude in Chrome navigates and provides the raw HTML, and this module handles all extraction. No outbound HTTP requests are made - it is a pure extraction layer.

This pattern is useful when you need a real browser session (for JS-rendered pages, authenticated content, or bot-protected sites) but still want structured extraction output rather than raw HTML.

### How it works

```
Claude in Chrome              chrome-pipe MCP server
      │                              │
      │  navigate to URL             │
      │  get_page_text() → html      │
      │ ─────────────────────────── >│
      │                    extract_page(url, html)
      │                              │
      │  < ────────────────────────── │
      │  PageSnapshot (seo, links,   │
      │  headings, schema, og)       │
```

### Tools

| Tool | Description |
|---|---|
| `extract_page` | Run the full extractor stack on a URL + HTML string. Returns SEO signals, links, headings, JSON-LD schema, and Open Graph data. |
| `extract_seo` | SEO signals only - title, description, canonical, robots, H1, word count, article word count, excerpt. |
| `extract_links` | Internal and external links with anchor text and rel attributes. |
| `batch_extract` | Run extraction on up to 100 pages at once. Returns a manifest array. |

### Claude Desktop config

```json
{
  "mcpServers": {
    "chrome-pipe": {
      "command": "node",
      "args": ["modules/chrome-pipe/dist/index.js"]
    }
  }
}
```

### Example Claude workflow

> "Navigate to https://example.com, get the page HTML, then pass it to chrome-pipe's `extract_page` tool and show me the SEO signals and heading structure."

Claude in Chrome handles the fetch. Chrome-pipe handles the extraction. The two MCP servers never talk to each other directly - Claude is the coordinator.

---

## Architecture

```
CrawlEngine.crawl()                          AsyncIterable<PageSnapshot>
  │
  ├── seed frontier (sitemap + seed URL)
  │
  └── dispatch loop
        promise pool (≤ workers concurrent tasks)
        each worker:
          robots check
          rate limit (per-host promise chain)
          FetchBackend.fetch()
            └── SsrfGuard.check()     block private IP ranges
          BodyDeduplicator.isDuplicate()
          cheerio.parse()             HTML only
          Extractor[].extract()       user-registered extractors
          emit PageSnapshot
          extract links → Frontier.submit()
```

### Concurrency model

The engine uses an explicit promise pool - the dispatch loop maintains up to `workers` concurrent promises and uses `Promise.race` to wait when the pool is full. This produces the same throughput as a thread-per-task model for I/O-bound crawling.

### Rate limiting (per-host)

Each worker chains onto the previous host promise, serialising requests to the same host at the configured delay with no atomics needed - Node.js's single-threaded event loop guarantees non-interleaved await points.

### 429 backoff

On HTTP 429, the worker releases its pool slot before sleeping and re-acquires it afterwards, so a long backoff does not starve other in-flight URLs.

---

## Security

### SSRF protection

Before connecting, every URL's hostname is resolved to IP and checked against blocked ranges:

| Range | Description |
|---|---|
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | RFC 1918 private |
| `127.0.0.0/8` | Loopback |
| `169.254.0.0/16` | Link-local / AWS instance metadata |
| `100.64.0.0/10` | Shared address space (RFC 6598) |
| `::1/128`, `fc00::/7`, `fe80::/10` | IPv6 loopback / unique-local / link-local |

The check fires at every hop of a redirect chain. To opt out for intranet crawling:

```ts
CrawlConfig.builder('http://intranet.corp/').ssrfPolicy(SsrfPolicy.ALLOW_ALL).build();
```

*Note: Playwright-based crawls (using `PlaywrightFetchBackend`) also enforce the same SSRF policy for all outgoing requests and sub-resources.*

### Path traversal & sandboxing

User-provided paths for file writes (e.g., `saveToFile` in MCP tools) are processed via `Security.sandboxPath()`. This ensures that:
- Operations are restricted to the `./scratch/` directory by default.
- Absolute paths and traversal components (`..`) that escape the sandbox are strictly rejected.

### Prototype pollution mitigation

All extractors that assign dynamic keys from untrusted HTML (Open Graph, Twitter Card, schema blocks) explicitly filter out `__proto__`, `constructor`, and `prototype` before assignment to prevent environment manipulation.

### Body size limit

Response bodies are capped at `maxBodyBytes` (default 5 MB). Truncated bodies still produce a snapshot - `fetchResult.bodyTruncated` is `true`.

### Redirect depth limit

Redirect chains are capped at `maxRedirects` (default 10). Longer chains are treated as errors.

---

## URL normalization

Before any URL is enqueued, `UrlNormalizer` applies these rules in order:

1. Reject non-http/https or malformed URLs
2. Lowercase scheme and host
3. Remove default ports (`:80` on http, `:443` on https)
4. Resolve dot segments
5. Strip fragment (`#...`)
6. Sort query parameters alphabetically
7. Strip tracking parameters: `utm_*`, `fbclid`, `gclid`, `gclsrc`, `dclid`, `zanpid`, `mc_cid`, `mc_eid`
8. Strip session parameters when `stripSessionParams=true`: `jsessionid`, `phpsessid`, `sid`, `sessionid`
9. Remove trailing slash on non-root, extension-free paths

Normalization is idempotent.

---

## Dependencies

### `core/` runtime

| Package | License | Purpose |
|---|---|---|
| `cheerio` | MIT | HTML parsing |
| `robots-parser` | MIT | robots.txt parsing |
| `undici` | MIT | HTTP client |
| `playwright-core` | Apache 2.0 | Headless browser for JS rendering |

### `modules/mcp-server/` runtime (adds to core)

| Package | License | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | MCP server protocol |
| `@mozilla/readability` | Apache 2.0 | Article extraction |
| `got-scraping` | MIT | TLS fingerprint spoofing for bot bypass |
| `jsdom` | MIT | DOM simulation for readability |
| `express` | MIT | HTTP transport for MCP |
| `zod` | MIT | Schema validation |

### `modules/chrome-pipe/` runtime (standalone)

| Package | License | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | MCP server protocol |
| `@mozilla/readability` | Apache 2.0 | Article extraction |
| `cheerio` | MIT | HTML parsing |
| `jsdom` | MIT | DOM simulation for readability |
| `zod` | MIT | Schema validation |

All dependencies are permissive open-source (MIT or Apache 2.0). All logic - frontier management, SSRF guard, URL normalizer, extractor framework, and MCP tool definitions - is original code in this repo.

---

## License

MIT © Timothy Nishimura. See [LICENSE](LICENSE).
