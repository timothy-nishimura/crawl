import { JSDOM }          from 'jsdom';
import { Readability }   from '@mozilla/readability';
import {
  type Extractor,
  type ParsedPage,
  FetchResult,
} from '@crawl/engine';

/**
 * Structured SEO metadata extracted from a crawled HTML page.
 * Returned by SeoExtractor and serialised into MCP tool responses.
 */
export interface SeoData {
  /** Contents of <title> */
  readonly title:            string;
  /** Contents of <meta name="description"> */
  readonly description:      string;
  /** Text of the first <h1> */
  readonly h1:               string;
  /**
   * Word count of visible body text with nav/header/footer/aside removed.
   * More accurate than a raw body count but still includes sidebars and
   * other boilerplate that Cheerio can't semantically identify.
   */
  readonly wordCount:        number;
  /**
   * Word count of the article extracted by Mozilla Readability — the same
   * algorithm used by Firefox Reader View. This is the best signal for
   * editorial content depth: it strips all page chrome and counts only the
   * main article body. Zero means Readability found no article.
   */
  readonly articleWordCount: number;
  /** First 300 characters of the Readability article (or body fallback). */
  readonly excerpt:          string;
}

// Chrome elements to strip before the Cheerio word count.
const CHROME_SELECTOR =
  'script, style, noscript, nav, header, footer, aside, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

/**
 * SEO extractor registered with CrawlEngine.
 *
 * Two word-count signals:
 *   wordCount        — Cheerio body minus common chrome selectors (fast)
 *   articleWordCount — Readability article extraction (editorial depth)
 *
 * Readability runs synchronously via JSDOM. At ~5–15 ms per page the
 * overhead is acceptable for crawls up to a few hundred pages.
 */
export class SeoExtractor implements Extractor<SeoData> {
  id(): string { return 'mcp.seo'; }

  extract(page: ParsedPage): SeoData | null {
    const doc = page.document;
    if (!doc) return null;

    // ── Standard meta fields ────────────────────────────────────────────
    const title       = doc('title').first().text().trim();
    const description = (doc('meta[name="description"]').attr('content') ?? '').trim();
    const h1          = doc('h1').first().text().trim();

    // ── Chrome-stripped word count (Cheerio) ────────────────────────────
    const bodyClone = doc('body').clone();
    bodyClone.find(CHROME_SELECTOR).remove();
    const bodyText  = bodyClone.text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.length > 0
      ? bodyText.split(/\s+/).filter(Boolean).length
      : 0;

    // ── Readability article extraction ──────────────────────────────────
    let articleWordCount = 0;
    let excerpt          = bodyText.slice(0, 300);

    try {
      const rawHtml = FetchResult.bodyText(page.fetchResult);
      const pageUrl = page.fetchResult.finalUri;

      // ── DoS: Limit HTML size for JSDOM parsing ──────────────────────────
      if (rawHtml.length > 3 * 1024 * 1024) {
        console.warn(`[SeoExtractor] Skipping JSDOM/Readability for large page (${rawHtml.length} bytes): ${pageUrl}`);
      } else {
        const dom = new JSDOM(rawHtml, {
          url: pageUrl,
          runScripts: 'outside-only',
        });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article) {
          // Safety: use textContent (plain text) not content (HTML). Readability does not
          // sanitize its HTML output — rendering article.content without DOMPurify is unsafe.
          const articleText = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
          articleWordCount = articleText.split(/\s+/).filter(Boolean).length;
          excerpt = articleText.slice(0, 300);
        }
      }
    } catch {
      // Readability failure is non-fatal; articleWordCount stays 0
    }

    return { title, description, h1, wordCount, articleWordCount, excerpt };
  }
}
