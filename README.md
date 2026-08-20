# Crawl Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![No Maintenance Intended](https://unmaintained.tech/badge.svg)](https://unmaintained.tech/)

> Released as an open-source snapshot for the community to use and build on. This codebase is not actively maintained — issues and pull requests are not monitored. Fork freely under the MIT license.

A modular, embeddable web crawler and MCP server toolkit for TypeScript/Node.js. Designed for crawl automation, SEO analysis, metadata extraction, and site auditing.

---

## Project Layout

```
crawl-engine/
├── core/                   @crawl/engine — core crawling kernel, frontier & security
├── modules/
│   ├── extractors/         @crawl/extractors — SEO, metadata, links, headings, schema, images
│   ├── tls-backend/        @crawl/tls-backend — TLS-fingerprinted fetch with socket SSRF defense
│   ├── chrome-pipe/        @crawl/chrome-pipe — Chrome-assisted extraction pipe
│   ├── mcp-server/         @crawl/mcp-server — production HTTP/SSE MCP server
│   └── mcp-test/           @crawl/mcp-test — smoke testing MCP server
├── docker-compose.yml      Docker Compose configuration
├── .env.example            Environment configuration template
└── scratch/                Sandbox output directory (gitignored)
```

**Architecture rule:** `@crawl/engine` has zero internal dependencies. Domain packages (`@crawl/extractors`, `@crawl/tls-backend`) build on the engine. User-facing applications (`@crawl/mcp-server`) assemble components into tools.

---

## Quick Start

**Requirements:** Node.js 20+

### Local Setup

```bash
# Install workspace dependencies
npm install

# Build all packages
npm run build --workspaces --if-present

# Run all test suites
npm run test --workspaces --if-present
```

### Docker Deployment

```bash
# Copy example environment
cp .env.example .env

# Build and start container
docker compose up -d

# Check health endpoint
curl http://localhost:3001/health
```

---

## Core Engine (`core/`)

### Basic Crawl

```ts
import {
  CrawlConfig,
  CrawlEngine,
  HttpClientBackend,
  SsrfPolicy,
} from '@crawl/engine';

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

### Custom Extractor

```ts
import type { Extractor, ParsedPage } from '@crawl/engine';

interface SchemaSignals {
  jsonLdBlocks: string[];
  hasProductSchema: boolean;
}

class SchemaExtractor implements Extractor<SchemaSignals> {
  readonly id = 'schema.jsonld';

  extract(page: ParsedPage): SchemaSignals | null {
    if (!page.document) return null;
    const blocks = page.document('script[type="application/ld+json"]')
      .map((_, el) => page.document?.(el).html() ?? '')
      .get();
    return {
      jsonLdBlocks: blocks,
      hasProductSchema: blocks.some(b => b.includes('"Product"')),
    };
  }
}
```

### Configuration Reference

`CrawlConfig.builder(seedUrl)` options:

| Setting | Default | Description |
|---|---|---|
| `maxDepth(n)` | `Infinity` | Maximum link depth from seed URL (`0` = seed only). |
| `crawlSubdomains(bool)` | `false` | Follow links across subdomains. |
| `includePattern(str)` | `none` | Substring match required for discovered URLs. |
| `excludePattern(str)` | `none` | Substring filter skipping matching URLs. |
| `workers(n)` | `4` | Concurrency limit for fetch workers. |
| `timeoutMs(ms)` | `10000` | Per-request timeout in milliseconds. |
| `maxBodyBytes(n)` | `5242880` | Maximum response payload size (5 MB default). |
| `maxRedirects(n)` | `10` | Maximum redirect hops before failure. |
| `requestDelayMs(ms)` | `500` | Per-host throttling delay. |
| `jitterPct(pct)` | `20` | Random jitter percentage on request delays. |
| `respectRobotsTxt(bool)` | `true` | Fetch and adhere to domain `robots.txt`. |
| `seedFromSitemap(bool)` | `true` | Pre-populate queue from discovered `sitemap.xml`. |
| `detectDuplicates(bool)` | `true` | SHA-256 body deduplication. |
| `stripSessionParams(bool)`| `true` | Strip session identifiers and tracking parameters. |
| `ssrfPolicy(policy)` | `BLOCK_PRIVATE` | SSRF defense mode (`BLOCK_PRIVATE` or `ALLOW_ALL`). |

---

## MCP Server (`modules/mcp-server/`)

Exposes crawl and inspection tools over Model Context Protocol (MCP) Streamable HTTP transport.

### Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server listening port |
| `MCP_API_KEY` | _(none)_ | Optional Bearer token for endpoint authorization |
| `SCRATCH_DIR` | `./scratch` | Directory for temporary runtime outputs |
| `MANIFESTS_DIR`| `./manifests` | Directory for saved crawl manifests |
| `DATA_DIR` | `./data` | Directory for persistent storage |

### Available Tools

| Tool | Description |
|---|---|
| `crawl` | Crawls target domain and returns structured manifest snapshots. |
| `fetch_page` | Fetches a single URL with SEO, heading, metadata, and link parsing. |
| `fetch_api` | Paginates through REST API endpoints and collects records. |
| `parse_sitemap` | Fetches and extracts URLs from `sitemap.xml`. |
| `search_manifest` | Filters crawl manifests by query, pattern, or status code. |
| `summarize_manifest` | Aggregates page counts, status distributions, and word counts. |
| `analyze_links` | Generates internal/external link graph and flags broken links. |
| `analyze_meta` | Audits canonical tags, robots directives, and Open Graph tags. |
| `analyze_headings` | Audits H1–H6 hierarchy, missing tags, and ordering issues. |
| `analyze_images` | Audits images for alt text, size, and missing attributes. |
| `analyze_schema` | Parses structured JSON-LD and microdata blocks. |
| `compare_manifests` | Computes diffs between two manifest runs (added/removed/modified). |
| `find_orphans` | Identifies crawl pages with zero inbound links. |

---

## Security Model

- **SSRF Defense**: Evaluates hostnames and IP addresses against blocked ranges prior to connection:
  * IPv4 Private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  * IPv4 Loopback & Link-Local: `127.0.0.0/8`, `169.254.0.0/16`
  * IPv4 Shared & Multicast: `100.64.0.0/10`, `224.0.0.0/4`
  * IPv6 Loopback & Link-Local: `::1/128`, `fe80::/10`, `fc00::/7`
  * IPv6 Multicast, 6to4 & Teredo: `ff00::/8`, `2002::/16`, `2001:0000::/32`
  * Socket-Level DNS Resolution: Connection hooks prevent TOCTOU DNS rebinding.
- **Multi-Root Sandbox Containment**: Path validation ensures disk writes remain bounded within configured directories (`scratch/`, `manifests/`, `data/`).
- **Session Protections**: MCP session pool enforces a 100-session capacity cap and reaps idle sessions after 30 minutes.
- **Unprivileged Containers**: Docker images run under non-root user (`pwuser`) with healthchecks.

---

## License

MIT © Timothy Nishimura. See [LICENSE](LICENSE).
