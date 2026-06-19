/**
 * @crawl/chrome-pipe — MCP server
 *
 * Architecture: Option A (Chrome as pipe, crawler as brain)
 *
 *   1. Claude calls a Claude-in-Chrome tool to navigate and get page HTML
 *   2. Claude passes that HTML to this module's tools
 *   3. This module runs the extractor stack and returns a structured snapshot
 *
 * This module makes ZERO outbound HTTP requests to target domains.
 * All fetching is done by the user's Chrome browser — clean IP/session separation.
 *
 * Tools
 * ─────
 *   extract_page   — full snapshot: SEO, links, headings, schema, Open Graph
 *   extract_seo    — SEO signals only (title, description, word counts, excerpt)
 *   extract_links  — internal + external link list
 *   batch_extract  — process multiple {url, html} pairs → manifest array
 *
 * Claude Desktop (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "chrome-pipe": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/modules/chrome-pipe/dist/index.js"]
 *       }
 *     }
 *   }
 *
 * Typical Claude prompt:
 *   "Navigate to https://example.com, get the page text, then extract the page."
 *   Claude will: navigate → get_page_text → extract_page(url, html)
 */

import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                    from 'zod';
import { extractPage }          from './extract.js';

const server = new McpServer({
  name:    'chrome-pipe',
  version: '1.0.0',
});

// ── Shared input fields ───────────────────────────────────────────────────────

const urlField  = z.string().url()
  .describe('The URL of the page. Used to resolve relative links and run Readability.');

const htmlField = z.string().min(1)
  .describe(
    'Raw HTML of the page as returned by Claude in Chrome\'s get_page_text or ' +
    'read_page tools. Pass the full string — no pre-processing needed.',
  );

// ── Tool: extract_page ────────────────────────────────────────────────────────

server.registerTool(
  'extract_page',
  {
    description:
      'Run the full extractor stack on HTML passed from Claude in Chrome. ' +
      'Returns SEO signals, internal/external links, heading structure (H1–H6 with issue flags), ' +
      'JSON-LD schema blocks, and Open Graph/Twitter Card meta tags. ' +
      'No HTTP request is made — Chrome already fetched the page.',
    inputSchema: { url: urlField, html: htmlField },
  },
  async ({ url, html }) => {
    const snapshot = extractPage(url, html);
    return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
  },
);

// ── Tool: extract_seo ─────────────────────────────────────────────────────────

server.registerTool(
  'extract_seo',
  {
    description:
      'Extract SEO signals only from HTML passed from Claude in Chrome: ' +
      'title, meta description, canonical URL, robots directive, H1, ' +
      'body word count, Readability article word count, and a 300-char excerpt. ' +
      'Lighter than extract_page when you only need content signals.',
    inputSchema: { url: urlField, html: htmlField },
  },
  async ({ url, html }) => {
    const { seo } = extractPage(url, html);
    return { content: [{ type: 'text', text: JSON.stringify(seo, null, 2) }] };
  },
);

// ── Tool: extract_links ───────────────────────────────────────────────────────

server.registerTool(
  'extract_links',
  {
    description:
      'Extract all links from HTML passed from Claude in Chrome. ' +
      'Returns two arrays — internal (same origin) and external — each with href, ' +
      'anchor text, and rel attribute (nofollow / sponsored / ugc). ' +
      'Deduplicates by resolved href. Skips mailto:, tel:, javascript:, and fragment-only links.',
    inputSchema: { url: urlField, html: htmlField },
  },
  async ({ url, html }) => {
    const { links } = extractPage(url, html);
    return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
  },
);

// ── Tool: batch_extract ───────────────────────────────────────────────────────

server.registerTool(
  'batch_extract',
  {
    description:
      'Process multiple pages at once — each with its own URL + HTML string ' +
      'from Claude in Chrome. Returns a manifest array of full page snapshots. ' +
      'Use this after a Chrome session that visited several pages: ' +
      'collect the {url, html} pairs then call this once for the full picture.',
    inputSchema: {
      pages: z.array(
        z.object({
          url:  urlField,
          html: htmlField,
        }),
      ).min(1).max(100)
        .describe('Array of {url, html} pairs. Max 100 per call.'),
    },
  },
  async ({ pages }) => {
    const manifest = pages.map(({ url, html }) => extractPage(url, html));
    return { content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }] };
  },
);

// ── Connect ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
