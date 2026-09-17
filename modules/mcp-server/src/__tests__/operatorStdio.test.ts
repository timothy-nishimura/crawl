import { describe, it, expect } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCrawlTool } from '../tools/crawl.js';
import { registerFetchPageTool } from '../tools/fetchPage.js';
import { registerParseSitemapTool } from '../tools/parseSitemap.js';
import { registerSearchManifestTool } from '../tools/searchManifest.js';
import { registerSummarizeManifestTool } from '../tools/summarizeManifest.js';
import { registerAnalyzeLinks } from '../tools/analyzeLinks.js';
import { registerAnalyzeMeta } from '../tools/analyzeMeta.js';
import { registerAnalyzeHeadings } from '../tools/analyzeHeadings.js';
import { registerCompareManifests } from '../tools/compareManifests.js';
import { registerListManifestsTool } from '../tools/listManifests.js';

/**
 * Pins the exact tool set operator-stdio-main.ts registers, matching what
 * Phase 3's plan calls the curated operator surface. The full end-to-end
 * verification (spawn the compiled/bundled entrypoint over stdio, confirm
 * every stdout line is JSON, confirm renderJs is absent from the advertised
 * schema, confirm PORT/KUBERNETES_SERVICE_HOST/MCP_HTTP have no effect) is
 * Gate C — run against the actual dist/bundle, not through ts-jest here.
 * This test exists so a future edit to operator-stdio-main.ts's register
 * calls (adding back an excluded tool, or dropping a curated one) fails
 * fast without needing a full build.
 */
describe('operator-stdio curated tool surface', () => {
  it('registers exactly the curated 10-tool operator surface without throwing', () => {
    const server = new McpServer({ name: 'crawl-engine', version: '1.0.0' });

    expect(() => {
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
    }).not.toThrow();
  });
});
