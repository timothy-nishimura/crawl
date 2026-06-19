import { z }                from 'zod';
import type { McpServer }  from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  HttpClientBackend,
  FetchRequest,
  FetchResult,
  SsrfPolicy,
} from '@crawl/engine';
import { TlsFetchBackend }  from '../backends/TlsFetchBackend.js';
import {
  saveManifest,
  type SitemapManifest,
  type SitemapEntry,
} from '../types/CrawlManifest.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const ParseSitemapInput = z.object({
  url: z
    .string()
    .url()
    .describe(
      'URL of the sitemap to fetch. Can be a sitemap.xml, sitemap_index.xml, or any ' +
      'standard XML sitemap. If omitted path, /sitemap.xml is tried automatically.',
    ),

  saveToFile: z
    .string()
    .describe(
      'Absolute path to write the SitemapManifest JSON. ' +
      'Use search_manifest to query the saved file.',
    ),

  maxUrls: z
    .coerce.number().int().min(1).max(50_000)
    .default(5_000)
    .describe('Maximum number of URLs to collect across all sitemaps in an index.'),
});

// ── XML parsing helpers ───────────────────────────────────────────────────────

/** Extract text content of a tag from a small XML fragment. */
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m || m[1] === undefined) return undefined;
  return m[1].trim().replace(/^<!\[CDATA\[|]]>$/g, '');
}

/** Parse <url> or <sitemap> blocks from sitemap XML. */
function parseUrlset(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // Match both <url>...</url> (urlset) and <sitemap>...</sitemap> (index)
  const blockRe = /<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    if (!block) continue;
    const loc   = tag(block, 'loc');
    if (!loc) continue;
    const entry: SitemapEntry = { url: loc };
    const lastmod    = tag(block, 'lastmod');
    const changefreq = tag(block, 'changefreq');
    const priority   = tag(block, 'priority');
    if (lastmod !== undefined)    entry.lastmod    = lastmod;
    if (changefreq !== undefined) entry.changefreq = changefreq;
    if (priority !== undefined)   entry.priority   = parseFloat(priority);
    entries.push(entry);
  }
  return entries;
}

/** True if the XML looks like a sitemapindex (contains <sitemap> children). */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchXml(
  url: string,
  timeoutMs = 15_000,
): Promise<{ body: string; statusCode: number; usedBypass: boolean }> {
  const normalBackend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
  let statusCode: number;
  let body: string;
  let usedBypass = false;

  try {
    const req    = FetchRequest.builder(url).timeoutMs(timeoutMs).build();
    const result = await normalBackend.fetch(req);
    statusCode   = result.statusCode;

    if (
      statusCode === 403 &&
      FetchResult.header(result, 'cf-ray') !== undefined
    ) {
      // Cloudflare block — retry with TLS bypass
      await normalBackend.close();
      const tlsBackend = await TlsFetchBackend.create();
      try {
        const tlsResult = await tlsBackend.fetch(req);
        statusCode  = tlsResult.statusCode;
        body        = FetchResult.bodyText(tlsResult);
        usedBypass  = true;
      } finally {
        tlsBackend.close();
      }
    } else {
      body = FetchResult.bodyText(result);
    }
  } finally {
    await normalBackend.close();
  }

  return { body: body!, statusCode, usedBypass };
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `parse_sitemap` tool on the given McpServer.
 *
 * Fetches a sitemap (including sitemap index files), collects all URL entries
 * with lastmod/changefreq/priority metadata, and saves a SitemapManifest to disk.
 *
 * Returns only {savedTo, urlCount} — the full URL list stays on disk.
 * Use search_manifest to query specific slices by URL pattern or date range.
 *
 * Typical workflow:
 *   1. parse_sitemap(url, saveToFile)        → SitemapManifest on disk
 *   2. search_manifest(path, {urlPattern})   → relevant URLs
 *   3. fetch_page(url, maxChars)             → page content
 */
export function registerParseSitemapTool(server: McpServer): void {
  server.tool(
    'parse_sitemap',

    'Fetch and parse an XML sitemap (including sitemap index files). ' +
    'Collects all URLs with lastmod, changefreq, and priority metadata. ' +
    'Saves a SitemapManifest to disk and returns only a lightweight summary. ' +
    'More token-efficient than crawling when you need a site\'s full URL inventory. ' +
    'Use search_manifest to query the saved file.',

    ParseSitemapInput.shape,

    async (args) => {
      const input = ParseSitemapInput.parse(args);

      // ── Normalize URL ─────────────────────────────────────────────────────
      let sitemapUrl = input.url;
      if (!sitemapUrl.toLowerCase().includes('sitemap')) {
        // Caller gave a domain root — try common sitemap path
        const base = sitemapUrl.replace(/\/$/, '');
        sitemapUrl = `${base}/sitemap.xml`;
      }

      // ── Fetch root sitemap ────────────────────────────────────────────────
      let rootFetch: { body: string; statusCode: number; usedBypass: boolean };
      try {
        rootFetch = await fetchXml(sitemapUrl);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Failed to fetch ${sitemapUrl}: ${String(err)}` }),
          }],
          isError: true,
        };
      }

      if (rootFetch.statusCode < 200 || rootFetch.statusCode >= 300) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Sitemap returned HTTP ${rootFetch.statusCode} for ${sitemapUrl}`,
            }),
          }],
          isError: true,
        };
      }

      // ── Resolve sitemap index or direct urlset ────────────────────────────
      const allEntries: SitemapEntry[] = [];

      if (isSitemapIndex(rootFetch.body)) {
        // Sitemap index — fetch each child sitemap
        const childUrls = parseUrlset(rootFetch.body).map(e => e.url);
        for (const childUrl of childUrls) {
          if (allEntries.length >= input.maxUrls) break;
          try {
            const childFetch = await fetchXml(childUrl);
            const childEntries = parseUrlset(childFetch.body);
            allEntries.push(...childEntries);
          } catch {
            // Skip unreachable child sitemaps
          }
        }
      } else {
        allEntries.push(...parseUrlset(rootFetch.body));
      }

      // Respect maxUrls cap
      const entries = allEntries.slice(0, input.maxUrls);

      // ── Build and save manifest ───────────────────────────────────────────
      const manifest: SitemapManifest = {
        meta: {
          source:     'sitemap',
          sitemapUrl: sitemapUrl,
          createdAt:  new Date().toISOString(),
          urlCount:   entries.length,
        },
        urls: entries,
      };

      try {
        saveManifest(input.saveToFile, manifest);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Failed to write manifest to ${input.saveToFile}: ${String(err)}`,
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            savedTo:    input.saveToFile,
            sitemapUrl: sitemapUrl,
            urlCount:   entries.length,
            usedBypass: rootFetch.usedBypass,
            note:       entries.length >= input.maxUrls
              ? `Capped at ${input.maxUrls} URLs. Increase maxUrls if the site has more.`
              : undefined,
          }),
        }],
      };
    },
  );
}
