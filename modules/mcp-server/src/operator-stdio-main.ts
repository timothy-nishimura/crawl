// console.log is redirected to stderr by operator-stdio.ts before this
// module is even imported — see that file for why it must be a dynamic
// import rather than a static one at the top of this file.

import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Curated operator surface only. Tools NOT imported here — fetch_api and
// analyze_schema (developer tools), find_orphans (needs a discovery
// manifest no operator tool produces), analyze_images (swap candidate) —
// are physically absent from this entrypoint's module graph, not merely
// unregistered, so a bundle built from this file cannot contain them.
import { registerCrawlTool } from './tools/crawl.js';
import { registerFetchPageTool } from './tools/fetchPage.js';
import { registerParseSitemapTool } from './tools/parseSitemap.js';
import { registerSearchManifestTool } from './tools/searchManifest.js';
import { registerSummarizeManifestTool } from './tools/summarizeManifest.js';
import { registerAnalyzeLinks } from './tools/analyzeLinks.js';
import { registerAnalyzeMeta } from './tools/analyzeMeta.js';
import { registerAnalyzeHeadings } from './tools/analyzeHeadings.js';
import { registerCompareManifests } from './tools/compareManifests.js';
import { registerListManifestsTool } from './tools/listManifests.js';

const VERSION = '1.0.0';

// A single CRAWL_DATA_HOME fallback derives all three sandbox dirs when the
// caller hasn't set them individually. ??= means an explicitly-set
// SCRATCH_DIR/MANIFESTS_DIR/DATA_DIR always wins — the plugin's .mcp.json
// sets those directly under ${CLAUDE_PLUGIN_DATA}, with CRAWL_DATA_HOME as
// a single-variable fallback in case nested substitution inside a longer
// string doesn't resolve.
{
  const dataHome = process.env['CRAWL_DATA_HOME'] ?? resolve(process.cwd(), '.crawl-data');
  process.env['SCRATCH_DIR']   ??= resolve(dataHome, 'scratch');
  process.env['MANIFESTS_DIR'] ??= resolve(dataHome, 'manifests');
  process.env['DATA_DIR']      ??= resolve(dataHome, 'data');
}

const server = new McpServer({
  name: 'crawl-engine',
  version: VERSION,
});

// hideRenderJs: true — this entrypoint never imports @crawl/playwright-backend,
// so advertising renderJs would offer a capability this build can't honor.
// autoManifest: true — operators shouldn't have to invent a filename;
// list_manifests is how they find a saved crawl again.
registerCrawlTool(server, { hideRenderJs: true, autoManifest: true });
registerFetchPageTool(server, { hideRenderJs: true, autoManifest: true });
registerParseSitemapTool(server);
registerSearchManifestTool(server);
registerSummarizeManifestTool(server);
registerAnalyzeLinks(server);
registerAnalyzeMeta(server);
registerAnalyzeHeadings(server);
registerCompareManifests(server);
registerListManifestsTool(server);

// No HTTP branch — stdio only. This is structural, not configuration:
// there is no express app here to listen on a PORT, so setting PORT,
// KUBERNETES_SERVICE_HOST, or MCP_HTTP has no effect on this entrypoint.
// No MCP_API_KEY either — meaningless over stdio, there's no request to
// authenticate.
const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error('[operator-stdio] Transport error:', err);
  process.exit(1);
});
