import { z }                      from 'zod';
import { JSDOM }                  from 'jsdom';
import { Readability }            from '@mozilla/readability';
import type { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync, readFileSync } from 'node:fs';
import {
  HttpClientBackend,
  PlaywrightFetchBackend,
  FetchResult,
  SsrfPolicy,
  Security,
  RateLimiter,
} from '@crawl/engine';
import { isSearchEngine, isJsGated } from '../lib/domain-hints.js';
import { TlsFetchBackend }        from '../backends/TlsFetchBackend.js';
import {
  fetchFollowingRedirects,
  isCloudflareBlock,
  type FetchResultInstance,
} from '../lib/fetch-utils.js';

// ── Input schema ───────────────────────────────────────────────────────────────

const FetchPageInput = z.object({
  url: z
    .string()
    .url()
    .describe('The URL to fetch and extract readable content from.'),

  headers: z
    .record(z.string())
    .optional()
    .describe(
      'Optional HTTP request headers to send (e.g. Referer, User-Agent, sec-ch-ua, ' +
      'Authorization, Cookie). Useful for APIs that require specific headers or for ' +
      'bypassing bot-detection checks that inspect header fingerprints.',
    ),

  maxBodyBytes: z
    .number().int().min(1024).max(10 * 1024 * 1024)
    .default(5 * 1024 * 1024)
    .describe('Maximum response body size in bytes (default 5 MB).'),

  timeoutMs: z
    .number().int().min(1000).max(30_000)
    .default(10_000)
    .describe('Request timeout in milliseconds (default 10 s).'),

  maxChars: z
    .number().int().min(100).max(100_000)
    .default(3_000)
    .describe(
      'Maximum characters of article content to return (default 3 000). ' +
      'Keeps context usage low for most tasks — increase to 10 000–50 000 only when ' +
      'you need the full article text. A truncated flag is added to the response when cut.',
    ),

  rawHtml: z
    .boolean()
    .default(false)
    .describe(
      'Return the raw HTML body instead of Readability-extracted article content. ' +
      'Use this when you need to access data embedded in the page source that ' +
      'Readability strips out — for example Next.js __NEXT_DATA__ script tags, ' +
      'inline JSON-LD blocks, or any <script> content. ' +
      'When true, maxChars still limits the returned string length.',
    ),

  renderJs: z
    .boolean()
    .default(false)
    .describe(
      'If true, use a headless browser (Playwright) to render the page before extracting. ' +
      'Essential for JS-heavy sites or when content is loaded asynchronously.',
    ),

  saveToFile: z
    .string()
    .optional()
    .describe(
      'Optional filename to save the full result as JSON in the scratch directory. ' +
      'Use this for large responses that might exceed token limits.',
    ),

  bypassBot: z
    .boolean()
    .default(false)
    .describe(
      'If true, use a Chrome TLS fingerprint for the request. ' +
      'Bypasses Cloudflare and similar bot-detection walls that block normal Node.js fetches. ' +
      'Only effective when renderJs is false.',
    ),

  delayMs: z
    .number()
    .min(0)
    .default(0)
    .describe(
      'Artificial delay in milliseconds before the request.',
    ),

  proxy: z
    .union([z.literal('none'), z.string().url()])
    .optional()
    .describe(
      'HTTP/HTTPS proxy URL to route the request through (e.g. http://127.0.0.1:8888). ' +
      'Pass "none" to explicitly disable any proxy (overrides CRAWL_PROXY env var). ' +
      'Falls back to the CRAWL_PROXY environment variable when not set explicitly.',
    ),

  preloadedHtml: z
    .string()
    .max(10_000_000, 'preloadedHtml must not exceed 10 MB')
    .optional()
    .describe(
      'Raw HTML string to parse instead of fetching the URL. ' +
      'When provided, all network fetch logic is skipped entirely — the given HTML is run ' +
      'directly through the Readability extraction pipeline. ' +
      'Useful when passing HTML from Claude in Chrome.',
    ),

  preloadedHtmlFile: z
    .string()
    .optional()
    .describe(
      'Filename (relative to SCRATCH_DIR) of an HTML file to parse instead of fetching the URL. ' +
      'Works identically to preloadedHtml but reads from disk — useful when the HTML is too ' +
      'large to pass inline. Write the file first with receiver.js, then call this tool. ' +
      'Example: "serp_capture.html"',
    ),
});

// fetchFollowingRedirects, isCloudflareBlock, and FetchResultInstance are
// imported from ../lib/fetch-utils.js

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Registers the `fetch_page` tool on the given McpServer.
 *
 * Fetches a single URL and extracts clean, readable article content using
 * Mozilla Readability — the same algorithm used by Firefox Reader View.
 * HTML boilerplate, navigation, ads, and footers are stripped automatically.
 * HTTP redirects are followed transparently (up to 10 hops).
 *
 * For HTML pages the result includes title, byline (author), publish date,
 * and the full plain-text article content.  For non-HTML responses (JSON,
 * XML, plain text) the raw decoded body is returned without processing.
 */
export function registerFetchPageTool(server: McpServer): void {
  server.tool(
    'fetch_page',

    'Fetch a single URL and extract its clean readable content. ' +
    'Follows HTTP redirects automatically. ' +
    'For HTML pages, Mozilla Readability strips navigation, ads, and boilerplate ' +
    'and returns just the article title, author, publish date, and body text. ' +
    'For non-HTML responses (JSON, XML, plain text) the raw decoded body is returned. ' +
    'Supports custom request headers via the headers param — useful for APIs that ' +
    'require Referer, Authorization, sec-ch-ua, Cookie, or other header fingerprints. ' +
    'Ideal for reading a specific page in full or calling a JSON API endpoint.',

    FetchPageInput.shape,

    async (args) => {
      const input = FetchPageInput.parse(args);

      // ── Pre-flight: JS-gated warning ────────────────────────────────────
      const notes: string[] = [];
      if (isJsGated(input.url) && !input.renderJs && !input.preloadedHtml) {
        notes.push(`[Warning] ${new URL(input.url).hostname} usually requires JS rendering. Results may be incomplete or obfuscated without renderJs: true.`);
      }

      // ── Preloaded HTML fast path ─────────────────────────────────────────
      // When the caller supplies raw HTML (inline or via file), skip all
      // network/fetch/proxy logic and go straight to extraction.
      if (input.preloadedHtmlFile) {
        const filePath = Security.sandboxPath(input.preloadedHtmlFile);
        let fileHtml: string;
        try {
          fileHtml = readFileSync(filePath, 'utf-8');
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ url: input.url, error: `Could not read preloadedHtmlFile "${input.preloadedHtmlFile}": ${String(err)}` }),
            }],
            isError: true,
          };
        }
        notes.push(`[PreloadedHtmlFile] Using HTML from ${filePath} (${fileHtml.length.toLocaleString()} bytes) — network fetch skipped.`);
        return parseAndExtract(input.url, fileHtml, input, notes);
      }

      if (input.preloadedHtml) {
        notes.push('[PreloadedHtml] Using caller-supplied HTML — network fetch skipped.');
        return parseAndExtract(input.url, input.preloadedHtml, input, notes);
      }

      // ── Proxy resolution: explicit param > CRAWL_PROXY env var ──────────
      // Pass proxy: "none" to explicitly disable the proxy env var.
      const proxy = input.proxy === 'none'
        ? undefined
        : (input.proxy ?? process.env['CRAWL_PROXY']);
      if (proxy) {
        notes.push(`[Proxy] Routing request through ${proxy}.`);
      }

      let backend: HttpClientBackend | TlsFetchBackend | PlaywrightFetchBackend;
      const renderJs = input.renderJs;
      let tlsBypass = false;

      if (renderJs) {
        backend = await PlaywrightFetchBackend.create({ headless: true, proxy });
      } else if (input.bypassBot) {
        backend = await TlsFetchBackend.create(SsrfPolicy.BLOCK_PRIVATE, proxy);
        tlsBypass = true;
      } else {
        backend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE, proxy);
      }

      const extraHeaders = input.headers ?? {};
      let result: FetchResultInstance;

      // ── Safety Layer: Rate Limiting & Delays ────────────────────────────
      const isSearch = isSearchEngine(input.url);
      const delay = input.delayMs;

      try {
        result = await RateLimiter.synchronized(isSearch ? 'search-engine' : 'global', async () => {
          if (delay > 0) {
            console.error(`[Safety] Delaying ${delay}ms before fetch for ${input.url}...`);
            await RateLimiter.sleep(delay);
          }

          return await fetchFollowingRedirects(
            input.url,
            input.maxBodyBytes,
            input.timeoutMs,
            backend,
            extraHeaders,
          );
        });
      } finally {
        await backend.close();
      }

      // ── Cloudflare / bot-wall auto-bypass (only if not already using TLS/JS) ───
      if (!renderJs && !tlsBypass && isCloudflareBlock(result)) {
        let tlsBackend: TlsFetchBackend;
        try {
          tlsBackend = await TlsFetchBackend.create(SsrfPolicy.BLOCK_PRIVATE, proxy);
        } catch (err) {
          // tls-client not available (e.g. Alpine image) — return the 403
          // with an explanatory note rather than crashing.
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                url:       input.url,
                statusCode: (result as { statusCode: number }).statusCode,
                error:     'Cloudflare block detected. TLS bypass unavailable: ' + String(err),
              }),
            }],
            isError: true,
          };
        }

        try {
          result = await fetchFollowingRedirects(
            input.url,
            input.maxBodyBytes,
            input.timeoutMs,
            tlsBackend,
            extraHeaders,
          );
          tlsBypass = true;
        } finally {
          await tlsBackend.close();
        }
      }

      // ── Network / HTTP error ─────────────────────────────────────────────
      if (FetchResult.isFetchError(result)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url:   input.url,
              error: result.error?.message ?? 'Network error',
            }),
          }],
          isError: true,
        };
      }

      if (!FetchResult.isSuccess(result)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url:        result.finalUri,
              statusCode: result.statusCode,
              error:      `HTTP ${result.statusCode}`,
              location:   FetchResult.header(result, 'location') ?? null,
            }),
          }],
          isError: true,
        };
      }

      // ── Non-HTML: return raw decoded text ────────────────────────────────
      if (!FetchResult.isHtml(result)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url:         result.finalUri,
              statusCode:  result.statusCode,
              contentType: result.contentType,
              body:        FetchResult.bodyText(result),
              ...(tlsBypass && { note: 'Fetched using TLS fingerprint bypass (Cloudflare).' }),
            }),
          }],
        };
      }

      // ── rawHtml: return raw HTML body without Readability processing ─────
      if (input.rawHtml) {
        const rawBody    = FetchResult.bodyText(result);
        const truncated  = rawBody.length > input.maxChars;
        const body       = truncated ? rawBody.slice(0, input.maxChars) : rawBody;
        if (truncated) notes.push(`HTML truncated to ${input.maxChars} chars (full: ${rawBody.length}). Increase maxChars to retrieve more.`);
        if (tlsBypass) notes.push('Fetched using TLS fingerprint bypass (Cloudflare).');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url:        result.finalUri,
              statusCode: result.statusCode,
              truncated,
              html:       body,
              ...(notes.length > 0 && { note: notes.join(' ') }),
            }),
          }],
        };
      }

      // ── HTML: extract readable article content ───────────────────────────
      const html = FetchResult.bodyText(result);

      // ── CAPTCHA / IP Block Detection ────────────────────────────────────
      if (html.includes('/sorry/index') || html.includes('unusual traffic') || html.includes('captcha')) {
        notes.push("[Critical] Google IP block detected (/sorry/index). Your IP has been flagged for unusual traffic. Please pause Google requests or use a proxy.");
      }

      const htmlLower = html.toLowerCase();
      if (htmlLower.includes('<noscript>') || htmlLower.includes('enable javascript')) {
        notes.push("[Note] Page content appears to be JS-gated. Some data may be missing or obfuscated. Consider renderJs: true.");
      }

      // ── DoS: Limit HTML size for JSDOM parsing ──────────────────────────
      if (html.length > 3 * 1024 * 1024) {
        notes.push(`Page is too large for structural extraction (${Math.round(html.length / 1024 / 1024)}MB). Returning truncated raw text.`);
        const rawText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const truncated = rawText.length > input.maxChars;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: result.finalUri,
              title: 'Large Page (Raw Text)',
              content: truncated ? rawText.slice(0, input.maxChars) : rawText,
              truncated,
              note: notes.join(' '),
            }),
          }],
        };
      }

      const dom = new JSDOM(html, {
        url: result.finalUri,
        runScripts: 'outside-only',
      });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        // Readability couldn't identify an article — fall back to raw text
        const rawText      = (dom.window.document.body?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const fbTruncated  = rawText.length > input.maxChars;
        const fallbackText = fbTruncated ? rawText.slice(0, input.maxChars) : rawText;

        const fbNotes = ['Readability could not identify a main article; returning body text.'];
        if (fbTruncated) fbNotes.push(`Truncated to ${input.maxChars} chars (full: ${rawText.length}).`);
        if (tlsBypass)   fbNotes.push('Fetched using TLS fingerprint bypass (Cloudflare).');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url:        result.finalUri,
              statusCode: result.statusCode,
              title:      dom.window.document.title ?? '',
              truncated:  fbTruncated,
              content:    fallbackText,
              note:       fbNotes.join(' '),
            }),
          }],
        };
      }

      const cleanText = (article.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      const truncated  = cleanText.length > input.maxChars;
      const content    = truncated ? cleanText.slice(0, input.maxChars) : cleanText;

      if (truncated)  notes.push(`Content truncated to ${input.maxChars} chars (full length: ${cleanText.length}). Increase maxChars to retrieve more.`);
      if (tlsBypass)  notes.push('Fetched using TLS fingerprint bypass (Cloudflare).');

      const finalResult = {
        url:           result.finalUri,
        statusCode:    result.statusCode,
        title:         article.title,
        byline:        article.byline ?? null,
        publishedTime: article.publishedTime ?? null,
        siteName:      article.siteName ?? null,
        excerpt:       article.excerpt ?? null,
        length:        article.length,
        truncated,
        content,
        ...(notes.length > 0 && { note: notes.join(' ') }),
      };

      if (input.saveToFile) {
        const safePath = Security.sandboxPath(input.saveToFile);
        writeFileSync(safePath, JSON.stringify(finalResult, null, 2), 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              savedTo:  safePath,
              url:      result.finalUri,
              title:    article.title,
              note:     notes.join(' '),
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(finalResult),
        }],
      };
    },
  );
}

// ── Shared HTML parsing / extraction pipeline ────────────────────────────────
//
// Used by both the normal fetch path and the preloadedHtml fast path.
// Accepts raw HTML + the original URL and runs Readability extraction.

export type FetchPageInputType = z.infer<typeof FetchPageInput>;
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function parseAndExtract(
  finalUri: string,
  html:     string,
  input:    FetchPageInputType,
  notes:    string[],
): ToolResult {

  // ── rawHtml passthrough ───────────────────────────────────────────────────
  if (input.rawHtml) {
    const truncated = html.length > input.maxChars;
    const body      = truncated ? html.slice(0, input.maxChars) : html;
    if (truncated) notes.push(`HTML truncated to ${input.maxChars} chars (full: ${html.length}). Increase maxChars to retrieve more.`);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ url: finalUri, statusCode: 200, truncated, html: body, ...(notes.length > 0 && { note: notes.join(' ') }) }),
      }],
    };
  }

  // ── DoS guard ─────────────────────────────────────────────────────────────
  if (html.length > 3 * 1024 * 1024) {
    notes.push(`Page is too large for structural extraction (${Math.round(html.length / 1024 / 1024)}MB). Returning truncated raw text.`);
    const rawText   = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const truncated = rawText.length > input.maxChars;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ url: finalUri, title: 'Large Page (Raw Text)', content: truncated ? rawText.slice(0, input.maxChars) : rawText, truncated, note: notes.join(' ') }),
      }],
    };
  }

  // ── Readability ───────────────────────────────────────────────────────────
  const dom     = new JSDOM(html, { url: finalUri, runScripts: 'outside-only' });
  const reader  = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    const rawText     = (dom.window.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const fbTruncated = rawText.length > input.maxChars;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          url:        finalUri,
          statusCode: 200,
          title:      dom.window.document.title ?? '',
          truncated:  fbTruncated,
          content:    fbTruncated ? rawText.slice(0, input.maxChars) : rawText,
          note:       ['Readability could not identify a main article; returning body text.', ...notes].join(' '),
        }),
      }],
    };
  }

  const cleanText = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
  const truncated = cleanText.length > input.maxChars;
  const content   = truncated ? cleanText.slice(0, input.maxChars) : cleanText;
  if (truncated) notes.push(`Content truncated to ${input.maxChars} chars (full length: ${cleanText.length}). Increase maxChars to retrieve more.`);

  const finalResult = {
    url:           finalUri,
    statusCode:    200,
    title:         article.title,
    byline:        article.byline        ?? null,
    publishedTime: article.publishedTime ?? null,
    siteName:      article.siteName      ?? null,
    excerpt:       article.excerpt       ?? null,
    length:        article.length,
    truncated,
    content,
    ...(notes.length > 0 && { note: notes.join(' ') }),
  };

  if (input.saveToFile) {
    const safePath = Security.sandboxPath(input.saveToFile);
    writeFileSync(safePath, JSON.stringify(finalResult, null, 2), 'utf-8');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ savedTo: safePath, url: finalUri, title: article.title, note: notes.join(' ') }),
      }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(finalResult) }],
  };
}
