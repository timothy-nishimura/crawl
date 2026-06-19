# Contributing to @crawl/mcp-server

## Development workflow

### Making source changes

Edit `.ts` files under `src/`. The MCP server runs from compiled `dist/` output,
so source changes are not live until you rebuild.

### ⚠️ Rebuild checkpoint

**After any source change, run this before running a live test:**

```bash
npm run build
```

Then restart the Claude desktop app (or reconnect the MCP server in settings)
so the new `dist/` files are loaded by the running process.

Skipping this step means the live server is still running the previous compiled
code. Test output will not reflect your changes.

### Running tests

```bash
npm test
```

Tests run against static HTML fixtures — no browser, no network, no MCP server
restart needed. Run tests first, then rebuild and live-test once green.

### Build notes

`npm run build` — strict tsc, exits non-zero if type errors.

`npm run build:force` — emits JS despite type errors. Useful in sandbox
environments where workspace symlinks are broken.
