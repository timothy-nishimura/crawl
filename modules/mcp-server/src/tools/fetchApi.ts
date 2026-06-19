/**
 * fetch_api — Paginated JSON API fetcher.
 *
 * Walks through an offset-paginated JSON API by replacing a `{offset}`
 * placeholder in the URL template on each iteration, collecting results
 * into a single array, and stopping when the data is exhausted or a
 * configured limit is reached.
 *
 * Example:
 *
 *   GET https://api.example.com/items?start={offset}&limit=20
 *
 * Supports custom headers, Cloudflare bypass, configurable delays, and
 * optional file output for large result sets.
 */

import fs                        from 'node:fs';
import { z }                     from 'zod';
import type { McpServer }        from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  HttpClientBackend,
  FetchResult,
  SsrfPolicy,
  Security,
} from '@crawl/engine';
import { TlsFetchBackend }       from '../backends/TlsFetchBackend.js';
import {
  fetchFollowingRedirects,
  fetchOnce,
  isCloudflareBlock,
  getPath,
  sleep,
} from '../lib/fetch-utils.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const FetchApiInput = z.object({
  urlTemplate: z
    .string()
    .describe(
      'URL with a {offset} placeholder that will be replaced with the current ' +
      'pagination offset on each request. The placeholder can appear anywhere in ' +
      'the URL, including inside a JSON-encoded query parameter. ' +
      'Example (simple): https://api.example.com/items?start={offset}&limit=20 ' +
      'Example (JSON param): https://site.com/api?query=%7B%22endIndex%22%3A{offset}%7D',
    ),

  headers: z
    .record(z.string())
    .optional()
    .describe(
      'Optional HTTP request headers to include on every request ' +
      '(e.g. Referer, User-Agent, sec-ch-ua, Authorization, Cookie).',
    ),

  pageSize: z
    .number().int().min(1).max(500)
    .default(20)
    .describe(
      'Number of items per page — used to increment the offset on each iteration ' +
      'and to detect the last page (when a page returns fewer items than this value). ' +
      'Must match the batchSize / limit / pageSize configured in the API request.',
    ),

  startOffset: z
    .number().int().min(0)
    .default(0)
    .describe('Starting offset value (default 0).'),

  maxPages: z
    .number().int().min(1).max(1000)
    .default(10)
    .describe('Hard cap on the number of pages to fetch (default 10).'),

  maxItems: z
    .number().int().min(1).max(50_000)
    .optional()
    .describe(
      'Stop after collecting this many total items, even if more pages remain. ' +
      'Useful when you only need the first N results from a large dataset.',
    ),

  resultsPath: z
    .string()
    .optional()
    .describe(
      'Dot-notation path to the results array within each JSON response. ' +
      'Examples: "content_elements", "data.items", "results.agents". ' +
      'If omitted, the root of the response is used when it is an array; ' +
      'otherwise each full response object is pushed as a single element.',
    ),

  totalPath: z
    .string()
    .optional()
    .describe(
      'Dot-notation path to the total item count in the response ' +
      '(e.g. "total", "metadata.totalCount"). When provided, pagination stops ' +
      'as soon as collected items ≥ total, avoiding an extra empty-page round-trip.',
    ),

  method: z
    .enum(['GET', 'POST'])
    .default('GET')
    .describe(
      'HTTP method for each page request (default GET). ' +
      'Set to POST for GraphQL or REST APIs that require a request body. ' +
      'When POST is used, redirect following is disabled.',
    ),

  requestBody: z
    .string()
    .optional()
    .describe(
      'Request body template sent with every POST request. ' +
      'The {offset} placeholder is replaced with the current pagination offset, ' +
      'just like in urlTemplate. Typically a JSON string for GraphQL or REST APIs. ' +
      'Example: {"query":"...","variables":{"offset":{offset},"limit":20}}',
    ),

  requestContentType: z
    .string()
    .default('application/json')
    .describe(
      'Content-Type header value for POST requests (default application/json). ' +
      'Ignored when method is GET.',
    ),

  bypassBot: z
    .boolean()
    .default(false)
    .describe(
      'Use a Chrome TLS fingerprint for all requests. ' +
      'Bypasses Cloudflare and similar bot-detection walls.',
    ),

  timeoutMs: z
    .number().int().min(1000).max(30_000)
    .default(10_000)
    .describe('Per-request timeout in milliseconds (default 10 s).'),

  delayMs: z
    .number().int().min(0).max(10_000)
    .default(300)
    .describe(
      'Delay between consecutive page requests in milliseconds (default 300 ms). ' +
      'Set to 0 to disable. Being polite reduces the chance of rate-limiting.',
    ),

  saveToFile: z
    .string()
    .optional()
    .describe(
      'Filename (relative to the scratch directory) to write the collected results as a JSON file. ' +
      'When set, only a lightweight summary is returned in the MCP response ' +
      'instead of the full result array. Strongly recommended for large datasets.',
    ),
});

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerFetchApiTool(server: McpServer): void {
  server.tool(
    'fetch_api',

    'Fetch all pages of an offset-paginated JSON API and return the combined results. ' +
    'Replace the pagination offset in the URL (or request body for POST APIs) with a ' +
    '{offset} placeholder — the tool increments it by pageSize on each iteration until ' +
    'the data is exhausted or limits are reached. Supports GET and POST (for GraphQL and ' +
    'body-paginated APIs), custom headers, Cloudflare bypass, configurable rate limiting, ' +
    'and optional file output for large datasets. ' +
    'Ideal for agent/team directories, property listings, GraphQL endpoints, and any REST ' +
    'API with endIndex / offset / skip-style pagination.',

    FetchApiInput.shape,

    async (args) => {
      const input = FetchApiInput.parse(args);
      const extraHeaders = input.headers ?? {};

      // ── Create backend ─────────────────────────────────────────────────────
      let backend: Awaited<ReturnType<typeof TlsFetchBackend.create>> | ReturnType<typeof HttpClientBackend.create>;
      let autoBypass = false;

      if (input.bypassBot) {
        try {
          backend    = await TlsFetchBackend.create();
          autoBypass = true;
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'bypassBot requested but TLS backend unavailable: ' + String(err),
            }) }],
            isError: true,
          };
        }
      } else {
        backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
      }

      // ── Pagination loop ────────────────────────────────────────────────────
      const allResults: unknown[] = [];
      let currentOffset = input.startOffset;
      let pagesFetched  = 0;
      let naturalEnd    = false;
      let lastError: string | null = null;

      const isPost = input.method === 'POST';

      // For POST, merge Content-Type into headers (caller-supplied value wins)
      const requestHeaders: Record<string, string> = isPost
        ? { 'content-type': input.requestContentType, ...extraHeaders }
        : extraHeaders;

      try {
        for (let page = 0; page < input.maxPages; page++) {
          const url  = input.urlTemplate.replace(/\{offset\}/g, String(currentOffset));
          const body = input.requestBody !== undefined
            ? input.requestBody.replace(/\{offset\}/g, String(currentOffset))
            : undefined;

          // POST uses fetchOnce (no redirect following); GET uses fetchFollowingRedirects
          let result = isPost
            ? await fetchOnce(url, 5 * 1024 * 1024, input.timeoutMs, backend, requestHeaders, 'POST', body)
            : await fetchFollowingRedirects(url, 5 * 1024 * 1024, input.timeoutMs, backend, requestHeaders);

          // ── Cloudflare auto-bypass ───────────────────────────────────────
          if (!autoBypass && isCloudflareBlock(result)) {
            await backend.close();
            try {
              backend    = await TlsFetchBackend.create();
              autoBypass = true;
              result     = isPost
                ? await fetchOnce(url, 5 * 1024 * 1024, input.timeoutMs, backend, requestHeaders, 'POST', body)
                : await fetchFollowingRedirects(url, 5 * 1024 * 1024, input.timeoutMs, backend, requestHeaders);
            } catch {
              // TLS backend unavailable — return what we have
              lastError = 'Cloudflare block detected on page ' + (page + 1) + '. TLS bypass unavailable.';
              break;
            }
          }

          // ── Network / HTTP error ─────────────────────────────────────────
          if (FetchResult.isFetchError(result)) {
            lastError = result.error?.message ?? 'Network error on page ' + (page + 1);
            break;
          }

          if (!FetchResult.isSuccess(result)) {
            lastError = `HTTP ${result.statusCode} on page ${page + 1}: ${url}`;
            break;
          }

          // ── Parse JSON body ──────────────────────────────────────────────
          const bodyText = FetchResult.bodyText(result);
          let json: unknown;
          try {
            json = JSON.parse(bodyText);
          } catch {
            lastError = `Non-JSON response on page ${page + 1} (contentType: ${result.contentType})`;
            break;
          }

          // ── Extract items ────────────────────────────────────────────────
          let items: unknown[];
          if (input.resultsPath) {
            const extracted = getPath(json, input.resultsPath);
            if (!Array.isArray(extracted)) {
              lastError =
                `resultsPath "${input.resultsPath}" did not resolve to an array on page ${page + 1}. ` +
                `Got: ${typeof extracted}`;
              break;
            }
            items = extracted;
          } else if (Array.isArray(json)) {
            items = json;
          } else {
            // No path, non-array root — push the whole response object
            allResults.push(json);
            naturalEnd = true;
            pagesFetched++;
            break;
          }

          allResults.push(...items);
          pagesFetched++;

          // ── Early stop: total count reached ──────────────────────────────
          if (input.totalPath) {
            const total = getPath(json, input.totalPath);
            if (typeof total === 'number' && allResults.length >= total) {
              naturalEnd = true;
              break;
            }
          }

          // ── Early stop: maxItems reached ─────────────────────────────────
          if (input.maxItems !== undefined && allResults.length >= input.maxItems) {
            break;
          }

          // ── Natural end: last page (short or empty) ───────────────────────
          if (items.length === 0 || items.length < input.pageSize) {
            naturalEnd = true;
            break;
          }

          currentOffset += input.pageSize;

          // ── Inter-page delay ─────────────────────────────────────────────
          if (input.delayMs > 0 && page < input.maxPages - 1) {
            await sleep(input.delayMs);
          }
        }
      } finally {
        await backend.close();
      }

      const summary = {
        urlTemplate:    input.urlTemplate,
        method:         input.method,
        pagesFetched,
        itemsCollected: allResults.length,
        naturalEnd,
        autoBypass,
        ...(lastError && { warning: lastError }),
      };

      // ── File mode ──────────────────────────────────────────────────────────
      if (input.saveToFile) {
        const output = { summary, results: allResults };
        try {
          const safePath = Security.sandboxPath(input.saveToFile);
          fs.writeFileSync(safePath, JSON.stringify(output, null, 2), 'utf8');
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: `Failed to write to ${input.saveToFile}: ${String(err)}`,
              summary,
            }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            savedTo: input.saveToFile,
            summary,
          }) }],
        };
      }

      // ── Inline mode ────────────────────────────────────────────────────────
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ summary, results: allResults }, null, 2) }],
      };
    },
  );
}
