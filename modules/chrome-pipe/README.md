# @crawl/chrome-pipe

**Architecture: Chrome as pipe, crawler as brain.**

Claude in Chrome handles navigation and session state. This module receives the raw HTML and runs the extractor stack — no server-side HTTP to the target domain.

```
Claude in Chrome          chrome-pipe MCP
────────────────          ───────────────────────────────────────
navigate(url)
get_page_text()  ──html──►  extract_page(url, html)
                 ◄─────────  { seo, links, headings, schema, og }
```

## Why this matters

The server IP never touches the target site. Chrome's authenticated session, cookies, and rendered JavaScript are all handled client-side. The extraction layer gets clean, fully-rendered HTML to work with.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `extract_page` | `url`, `html` | Full snapshot: SEO + links + headings + schema + Open Graph |
| `extract_seo` | `url`, `html` | Title, description, canonical, robots, word counts, excerpt |
| `extract_links` | `url`, `html` | Internal + external links with anchor text and rel |
| `batch_extract` | `[{url, html}]` | Manifest array — one snapshot per page, up to 100 |

## Setup

```bash
# From repo root
npm install
npm run build -w modules/chrome-pipe
```

## Claude Desktop config

Add both this module and Claude in Chrome to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-pipe": {
      "command": "node",
      "args": ["/absolute/path/to/modules/chrome-pipe/dist/index.js"]
    }
  }
}
```

Claude in Chrome is enabled separately via the browser extension.

## Example prompts

**Single page:**
> "Navigate to https://example.com, get the page HTML, then extract the full page snapshot."

Claude will:
1. Call `navigate` (Chrome tool)
2. Call `get_page_text` (Chrome tool) → raw HTML
3. Call `extract_page(url, html)` (this module) → structured snapshot

**Authenticated session:**
> "Log into the dashboard at https://app.example.com, go to the analytics page, and extract all the links."

Claude handles auth via Chrome tools, then calls `extract_links` with the rendered HTML — no credentials ever reach the server.

**Multi-page session:**
> "Visit these 5 product pages and give me a manifest of their SEO data."

Claude navigates each in Chrome, collects `{url, html}` pairs, then calls `batch_extract` once.

## Extractor stack

| Extractor | Output |
|---|---|
| SEO | title, meta description, canonical, robots, H1, word count (body + Readability article), 300-char excerpt |
| Links | internal + external arrays, anchor text, rel (nofollow/sponsored/ugc), deduped by resolved href |
| Headings | H1–H6 in document order, per-level counts, issue flags (missingH1, multipleH1, h1NotFirst, skippedLevels) |
| Schema | All `<script type="application/ld+json">` blocks, parsed with `@type` surfaced |
| Open Graph | All `og:*` and `twitter:*` meta tags |

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP stdio transport |
| `cheerio` | Fast HTML parsing |
| `jsdom` + `@mozilla/readability` | Article word count extraction |
| `zod` | Input validation |

No Playwright. No undici. No outbound HTTP at runtime.
