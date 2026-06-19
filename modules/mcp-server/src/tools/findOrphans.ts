import { z }              from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadManifest,
  isCrawlManifest,
  isDiscoveryManifest,
} from '../types/CrawlManifest.js';
import { normalizeUrl }     from '../lib/link-graph.js';

const FindOrphansInput = z.object({
  crawlManifestPath: z
    .string()
    .describe('Absolute path to the crawl manifest.'),
  discoveryManifestPath: z
    .string()
    .describe('Absolute path to the discovery manifest.'),
  limit: z
    .number().int().min(1).max(500)
    .default(100)
    .describe('Max orphans to return.'),
});

export function registerFindOrphans(server: McpServer): void {
  server.tool(
    'find_orphans',
    'Find orphan pages by comparing a crawl manifest with a discovery manifest.',
    FindOrphansInput.shape,
    async (args) => {
      const input = FindOrphansInput.parse(args);
      let crawlManifest, discoveryManifest;

      try {
        crawlManifest = loadManifest(input.crawlManifestPath);
        discoveryManifest = loadManifest(input.discoveryManifestPath);
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      if (!isCrawlManifest(crawlManifest)) {
        return {
          content: [{ type: 'text', text: 'Invalid crawl manifest.' }],
          isError: true,
        };
      }
      if (!isDiscoveryManifest(discoveryManifest)) {
        return {
          content: [{ type: 'text', text: 'Invalid discovery manifest.' }],
          isError: true,
        };
      }

      const crawledUrls = new Set(crawlManifest.pages.map(p => normalizeUrl(p.url)));
      const orphans = discoveryManifest.results.filter((r: { url: string }) => !crawledUrls.has(normalizeUrl(r.url)));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: {
              orphansFound: orphans.length,
              domain: discoveryManifest.meta.domain,
            },
            orphans: orphans.slice(0, input.limit)
          }, null, 2)
        }]
      };
    }
  );
}
