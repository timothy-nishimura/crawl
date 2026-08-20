import { describe, it, expect } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCrawlTool } from '../tools/crawl.js';
import { registerFetchPageTool } from '../tools/fetchPage.js';
import { registerFetchApiTool } from '../tools/fetchApi.js';
import { registerParseSitemapTool } from '../tools/parseSitemap.js';
import { registerSearchManifestTool } from '../tools/searchManifest.js';
import { registerSummarizeManifestTool } from '../tools/summarizeManifest.js';
import { registerAnalyzeLinks } from '../tools/analyzeLinks.js';
import { registerAnalyzeMeta } from '../tools/analyzeMeta.js';
import { registerAnalyzeHeadings } from '../tools/analyzeHeadings.js';
import { registerAnalyzeImages } from '../tools/analyzeImages.js';
import { registerAnalyzeSchema } from '../tools/analyzeSchema.js';
import { registerCompareManifests } from '../tools/compareManifests.js';
import { registerFindOrphans } from '../tools/findOrphans.js';

describe('mcp-server tool registration', () => {
  it('registers all tools without throwing', () => {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });

    expect(() => {
      registerCrawlTool(server);
      registerFetchPageTool(server);
      registerFetchApiTool(server);
      registerParseSitemapTool(server);
      registerSearchManifestTool(server);
      registerSummarizeManifestTool(server);
      registerAnalyzeLinks(server);
      registerAnalyzeMeta(server);
      registerAnalyzeHeadings(server);
      registerAnalyzeImages(server);
      registerAnalyzeSchema(server);
      registerCompareManifests(server);
      registerFindOrphans(server);
    }).not.toThrow();
  });
});
