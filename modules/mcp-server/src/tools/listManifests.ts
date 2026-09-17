import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readdirSync } from 'node:fs';
import {
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
  isDiscoveryManifest,
} from '@crawl/engine';
import { resolveManifestName } from '../lib/manifest-paths.js';

const ListManifestsInput = z.object({});

/**
 * Registers the `list_manifests` tool: lists saved manifests by name so
 * callers never need to guess or construct a filesystem path — the names
 * returned here can be passed directly to search_manifest,
 * summarize_manifest, analyze_*, or compare_manifests.
 */
export function registerListManifestsTool(server: McpServer): void {
  server.tool(
    'list_manifests',

    'List saved crawl/sitemap/discovery manifests, newest first, with a one-line summary of each. ' +
    'Use this instead of guessing a manifest filename — pass the returned name directly to ' +
    'search_manifest, summarize_manifest, analyze_meta, analyze_links, analyze_headings, or compare_manifests.',

    ListManifestsInput.shape,

    async () => {
      const manifestsDir = resolveManifestName('.');
      let files: string[];
      try {
        files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ manifests: [] }) }] };
      }

      const manifests = files
        .map(name => {
          try {
            const m = loadManifest(resolveManifestName(name));
            if (isCrawlManifest(m)) {
              return { name, source: 'crawl' as const, seedUrl: m.meta.seedUrl, createdAt: m.meta.createdAt, pagesCaptured: m.meta.pagesCaptured };
            }
            if (isSitemapManifest(m)) {
              return { name, source: 'sitemap' as const, sitemapUrl: m.meta.sitemapUrl, createdAt: m.meta.createdAt, urlCount: m.meta.urlCount };
            }
            if (isDiscoveryManifest(m)) {
              return { name, source: 'discovery' as const, domain: m.meta.domain, createdAt: m.meta.createdAt, urlCount: m.meta.urlCount };
            }
            return null;
          } catch {
            return null; // corrupt or unreadable — skip rather than fail the whole listing
          }
        })
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ manifests }, null, 2),
        }],
      };
    },
  );
}
