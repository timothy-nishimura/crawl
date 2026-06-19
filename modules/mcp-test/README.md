# @crawl/mcp-test

Minimal MCP server for smoke-testing the crawl engine. Three tools, stdio transport, zero external services required.

## Tools

| Tool | What it does |
|---|---|
| `fetch_page` | Fetch a single URL — returns status, title, meta description, word count, link counts |
| `crawl_site` | Crawl up to N pages from a seed URL — returns per-page summary + status breakdown |
| `parse_sitemap` | Fetch a sitemap.xml and return all discovered URLs |

## Setup

```bash
# From the repo root
npm install
npm run build -w modules/mcp-test
```

## Run with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crawl-test": {
      "command": "node",
      "args": ["/absolute/path/to/crawler/modules/mcp-test/dist/index.js"]
    }
  }
}
```

Then restart Claude Desktop and ask: *"Fetch the page https://example.com and tell me its title and word count."*

## Run with mcp dev

```bash
npx @modelcontextprotocol/inspector node modules/mcp-test/dist/index.js
```

## Difference from `mcp-server`

`mcp-test` is intentionally minimal — no Express, no Playwright, no session management. It's the right starting point if you want to understand how the engine works or build your own MCP module. Once you need manifest search or JS rendering, switch to `modules/mcp-server`.
