/**
 * @crawl/mcp-test — minimal MCP server for smoke-testing the crawl engine.
 *
 * Runs over stdio so it works with Claude Desktop and `mcp dev` out of the box.
 * Registers three tools:
 *
 *   fetch_page     — fetch a single URL, return status + fetch duration
 *   crawl_site     — crawl up to N pages from a seed URL, return a page list
 *   parse_sitemap  — fetch a sitemap.xml and return all discovered URLs
 *
 * Usage (after `npm run build`):
 *
 *   node dist/index.js
 *
 * Claude Desktop (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "crawl-test": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/modules/mcp-test/dist/index.js"]
 *       }
 *     }
 *   }
 */

import { McpServer }           from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                   from 'zod';

import {
  CrawlConfig,
  CrawlEngine,
  HttpClientBackend,
  SsrfPolicy,
} from '@crawl/engine';

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'crawl-test',
  version: '1.0.0',
});

// ── Tool: fetch_page ──────────────────────────────────────────────────────────

server.registerTool(
  'fetch_page',
  {
    description:
      'Fetch a single URL and return its HTTP status, content type, fetch duration, ' +
      'and whether the body was truncated. No extractors are registered — this is a ' +
      'raw engine smoke test. Use the full mcp-server module for rich SEO extraction.',
    inputSchema: {
      url: z.string().url().describe('The URL to fetch.'),
    },
  },
  async ({ url }) => {
    const backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);

    const config = CrawlConfig.builder(url)
      .maxDepth(0)
      .workers(1)
      .seedFromSitemap(false)
      .build();

    let snapshot = null;
    try {
      for await (const page of new CrawlEngine(config, backend, []).crawl()) {
        snapshot = page;
        break;
      }
    } finally {
      await backend.close();
    }

    if (!snapshot) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No response received.' }) }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          url:           snapshot.url,
          statusCode:    snapshot.statusCode,
          contentType:   snapshot.fetchResult.contentType,
          fetchDurationMs: snapshot.fetchResult.fetchDurationMs,
          bodyTruncated: snapshot.fetchResult.bodyTruncated,
          isDuplicate:   snapshot.isDuplicate,
          depth:         snapshot.depth,
        }, null, 2),
      }],
    };
  },
);

// ── Tool: crawl_site ──────────────────────────────────────────────────────────

server.registerTool(
  'crawl_site',
  {
    description:
      'Crawl a site from a seed URL and return a summary: total pages captured, ' +
      'status code breakdown, and a list of all crawled URLs with their status codes. ' +
      'Respects robots.txt and rate limits by default.',
    inputSchema: {
      url:      z.string().url().describe('Seed URL to start crawling from.'),
      maxPages: z.number().int().min(1).max(500).default(50)
        .describe('Maximum pages to crawl (default: 50).'),
      maxDepth: z.number().int().min(0).max(10).default(3)
        .describe('Maximum link hops from the seed (default: 3).'),
      delayMs:  z.number().int().min(0).max(5000).default(300)
        .describe('Milliseconds between requests per host (default: 300).'),
    },
  },
  async ({ url, maxPages, maxDepth, delayMs }) => {
    const backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);

    const config = CrawlConfig.builder(url)
      .maxDepth(maxDepth)
      .requestDelayMs(delayMs)
      .workers(4)
      .build();

    const pages: Array<{ url: string; status: number; depth: number }> = [];
    const statusCounts: Record<number, number> = {};

    try {
      for await (const page of new CrawlEngine(config, backend, []).crawl()) {
        pages.push({ url: page.url, status: page.statusCode, depth: page.depth });
        statusCounts[page.statusCode] = (statusCounts[page.statusCode] ?? 0) + 1;
        if (pages.length >= maxPages) break;
      }
    } finally {
      await backend.close();
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ totalPages: pages.length, statusBreakdown: statusCounts, pages }, null, 2),
      }],
    };
  },
);

// ── Tool: parse_sitemap ───────────────────────────────────────────────────────

server.registerTool(
  'parse_sitemap',
  {
    description:
      'Fetch a sitemap.xml (or sitemap index) and return all URLs discovered. ' +
      'Uses the engine\'s built-in sitemap parser.',
    inputSchema: {
      url: z.string().url().describe('URL of the sitemap.xml to fetch.'),
    },
  },
  async ({ url }) => {
    const backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);

    // maxDepth(0) + seedFromSitemap — engine seeds frontier from sitemap then
    // crawls just the seed page itself. The frontier URLs are the sitemap entries.
    const config = CrawlConfig.builder(url)
      .maxDepth(0)
      .seedFromSitemap(true)
      .workers(1)
      .build();

    const urls: string[] = [];
    try {
      for await (const page of new CrawlEngine(config, backend, []).crawl()) {
        urls.push(page.url);
      }
    } finally {
      await backend.close();
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ sitemapUrl: url, urlCount: urls.length, urls }, null, 2),
      }],
    };
  },
);

// ── Connect ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
