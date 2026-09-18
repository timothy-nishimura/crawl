import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
  isDiscoveryManifest,
} from '@crawl/engine';
import { resolveManifestName } from '../lib/manifest-paths.js';

const ListManifestsInput = z.object({});

export type ManifestListEntry =
  | { name: string; source: 'crawl'; seedUrl: string; createdAt: string; pagesCaptured: number }
  | { name: string; source: 'sitemap'; sitemapUrl: string; createdAt: string; urlCount: number }
  | { name: string; source: 'discovery'; domain: string; createdAt: string; urlCount: number }
  | { name: string; source: 'fetch_page'; url: string; title: string | undefined; statusCode: number; createdAt: string };

/**
 * Lists every recognizable file under MANIFESTS_DIR: real AnyManifest files
 * (crawl/sitemap/discovery), plus fetch_page's autoManifest saves — a flat
 * {url, statusCode, title, ...} result with no meta.source, so it isn't an
 * AnyManifest and loadManifest() rejects it. Recognizing that shape
 * specifically (rather than silently dropping it) matters: an operator who
 * just fetched a page and got a savedTo path back should still find it here.
 * Exported separately from the tool registration so it's directly testable
 * without going through MCP's request/response machinery.
 */
export function listManifests(): ManifestListEntry[] {
  const manifestsDir = resolveManifestName('.');
  let files: string[];
  try {
    files = readdirSync(manifestsDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  return files
    .map(name => {
      const fullPath = resolveManifestName(name);
      try {
        const m = loadManifest(fullPath);
        if (isCrawlManifest(m)) {
          return { name, source: 'crawl' as const, seedUrl: m.meta.seedUrl, createdAt: m.meta.createdAt, pagesCaptured: m.meta.pagesCaptured, sortKey: m.meta.createdAt };
        }
        if (isSitemapManifest(m)) {
          return { name, source: 'sitemap' as const, sitemapUrl: m.meta.sitemapUrl, createdAt: m.meta.createdAt, urlCount: m.meta.urlCount, sortKey: m.meta.createdAt };
        }
        if (isDiscoveryManifest(m)) {
          return { name, source: 'discovery' as const, domain: m.meta.domain, createdAt: m.meta.createdAt, urlCount: m.meta.urlCount, sortKey: m.meta.createdAt };
        }
        return null;
      } catch {
        try {
          const raw = JSON.parse(readFileSync(fullPath, 'utf-8')) as Record<string, unknown>;
          if (typeof raw['url'] === 'string' && typeof raw['statusCode'] === 'number') {
            const mtime = statSync(fullPath).mtime.toISOString();
            return {
              name,
              source: 'fetch_page' as const,
              url: raw['url'],
              title: typeof raw['title'] === 'string' ? raw['title'] : undefined,
              statusCode: raw['statusCode'],
              createdAt: mtime,
              sortKey: mtime,
            };
          }
        } catch {
          // fall through — corrupt or unrecognized, skip below
        }
        return null; // corrupt or unrecognized — skip rather than fail the whole listing
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ sortKey: _sortKey, ...rest }) => rest);
}

/**
 * Registers the `list_manifests` tool: lists saved manifests by name so
 * callers never need to guess or construct a filesystem path — the names
 * returned here can be passed directly to search_manifest,
 * summarize_manifest, analyze_*, or compare_manifests.
 */
export function registerListManifestsTool(server: McpServer): void {
  server.tool(
    'list_manifests',

    'List saved crawl/sitemap/discovery manifests and fetch_page results, newest first, with a ' +
    'one-line summary of each. Use this instead of guessing a filename — pass the returned name ' +
    'directly to search_manifest, summarize_manifest, analyze_meta, analyze_links, analyze_headings, ' +
    'or compare_manifests (fetch_page results aren\'t manifests and can\'t be passed to those tools — ' +
    're-fetch the URL directly instead).',

    ListManifestsInput.shape,

    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ manifests: listManifests() }, null, 2),
        }],
      };
    },
  );
}
