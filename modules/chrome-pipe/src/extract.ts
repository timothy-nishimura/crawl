/**
 * extract.ts — pure extraction layer for chrome-pipe.
 *
 * Takes a URL + raw HTML string (as handed off by Claude in Chrome's
 * get_page_text / read_page tools) and runs the full extractor stack.
 * Makes zero outbound HTTP requests.
 */

import { load }        from 'cheerio';
import { JSDOM }       from 'jsdom';
import { Readability } from '@mozilla/readability';

// ── Output types ──────────────────────────────────────────────────────────────

export interface SeoData {
  title:            string;
  description:      string;
  canonical:        string | null;
  robots:           string | null;
  h1:               string;
  wordCount:        number;
  articleWordCount: number;
  excerpt:          string;
}

export interface LinkEntry {
  href:   string;
  anchor: string;
  rel?:   'nofollow' | 'sponsored' | 'ugc';
}

export interface LinkData {
  internal: LinkEntry[];
  external: LinkEntry[];
}

export interface HeadingEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text:  string;
}

export interface HeadingData {
  headings: HeadingEntry[];
  counts:   { h1: number; h2: number; h3: number; h4: number; h5: number; h6: number };
  issues:   {
    missingH1:     boolean;
    multipleH1:    boolean;
    h1NotFirst:    boolean;
    skippedLevels: boolean;
  };
}

export interface SchemaBlock {
  type:  string | string[] | null;
  raw:   unknown;
}

export interface PageSnapshot {
  url:      string;
  seo:      SeoData;
  links:    LinkData;
  headings: HeadingData;
  schema:   SchemaBlock[];
  openGraph: Record<string, string>;
}

// ── Chrome element selectors stripped before word-count ───────────────────────
const CHROME_SELECTOR =
  'script, style, noscript, nav, header, footer, aside, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

// ── SEO extractor ─────────────────────────────────────────────────────────────

function extractSeo(url: string, html: string): SeoData {
  const $ = load(html);

  const title       = $('title').first().text().trim();
  const description = ($('meta[name="description"]').attr('content') ?? '').trim();
  const canonical   = $('link[rel="canonical"]').attr('href')?.trim() ?? null;
  const robots      = $('meta[name="robots"]').attr('content')?.trim() ?? null;
  const h1          = $('h1').first().text().trim();

  // Chrome-stripped word count
  const bodyClone = $('body').clone();
  bodyClone.find(CHROME_SELECTOR).remove();
  const bodyText  = bodyClone.text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.length > 0 ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  // Readability article extraction
  let articleWordCount = 0;
  let excerpt          = bodyText.slice(0, 300);

  if (html.length <= 3 * 1024 * 1024) {
    try {
      const dom    = new JSDOM(html, { url, runScripts: 'outside-only' });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      if (article) {
        // Safety: use textContent (plain text) not content (HTML). Readability does not
        // sanitize its HTML output — rendering article.content without DOMPurify is unsafe.
        const text   = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
        articleWordCount = text.split(/\s+/).filter(Boolean).length;
        excerpt = text.slice(0, 300);
      }
    } catch {
      // Non-fatal — keep bodyText excerpt
    }
  }

  return { title, description, canonical, robots, h1, wordCount, articleWordCount, excerpt };
}

// ── Link extractor ────────────────────────────────────────────────────────────

function extractLinks(url: string, html: string): LinkData {
  const $       = load(html);
  const origin  = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const seen    = new Set<string>();
  const internal: LinkEntry[] = [];
  const external: LinkEntry[] = [];

  $('a[href]').each((_i, el) => {
    const rawHref = $(el).attr('href')?.trim();
    if (!rawHref) return;

    const lower = rawHref.toLowerCase();
    if (
      lower.startsWith('#') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('javascript:')
    ) return;

    let resolved: string;
    try {
      const u  = new URL(rawHref, url);
      u.hash   = '';
      resolved = u.toString();
    } catch { return; }

    if (seen.has(resolved)) return;
    seen.add(resolved);

    const anchor  = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 100);
    const relAttr = ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/);
    const rel: LinkEntry['rel'] =
      relAttr.includes('sponsored') ? 'sponsored' :
      relAttr.includes('ugc')       ? 'ugc'       :
      relAttr.includes('nofollow')  ? 'nofollow'  :
      undefined;

    const entry: LinkEntry = { href: resolved, anchor, ...(rel !== undefined && { rel }) };

    try {
      const linkOrigin = new URL(resolved).origin;
      (linkOrigin === origin ? internal : external).push(entry);
    } catch { /* skip unparseable */ }
  });

  return { internal, external };
}

// ── Heading extractor ─────────────────────────────────────────────────────────

function extractHeadings(html: string): HeadingData {
  const $        = load(html);
  const headings: HeadingEntry[] = [];
  const counts   = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };

  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    const $el = $(el);
    if ($el.attr('aria-hidden') === 'true') return;

    const tag   = ($el.prop('tagName') as string).toLowerCase();
    const level = parseInt(tag[1]!, 10) as 1 | 2 | 3 | 4 | 5 | 6;
    const text  = $el.text().replace(/\s+/g, ' ').trim().slice(0, 200);

    headings.push({ level, text });
    counts[`h${level}` as keyof typeof counts]++;
  });

  const missingH1  = counts.h1 === 0;
  const multipleH1 = counts.h1 > 1;
  const firstH1Idx = headings.findIndex(h => h.level === 1);
  const h1NotFirst = !missingH1 && firstH1Idx > 0;

  let skippedLevels = false;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i]!.level > headings[i - 1]!.level + 1) { skippedLevels = true; break; }
  }

  return { headings, counts, issues: { missingH1, multipleH1, h1NotFirst, skippedLevels } };
}

// ── Schema.org extractor ──────────────────────────────────────────────────────

function extractSchema(html: string): SchemaBlock[] {
  const $      = load(html);
  const blocks: SchemaBlock[] = [];

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).html()?.trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      blocks.push({
        type: (parsed['@type'] as string | string[] | null) ?? null,
        raw:  parsed,
      });
    } catch { /* malformed block */ }
  });

  return blocks;
}

// ── Open Graph extractor ──────────────────────────────────────────────────────

function extractOpenGraph(html: string): Record<string, string> {
  const $  = load(html);
  const og: Record<string, string> = {};

  $('meta[property^="og:"], meta[name^="twitter:"]').each((_i, el) => {
    const key = ($(el).attr('property') ?? $(el).attr('name') ?? '').trim();
    const val = ($(el).attr('content') ?? '').trim();
    // Guard against prototype-poisoning keys from malicious pages
    if (!key || !val) return;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    og[key] = val;
  });

  return og;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full extractor stack on a URL + HTML string.
 * This is the only public export — the MCP tools call this.
 */
export function extractPage(url: string, html: string): PageSnapshot {
  return {
    url,
    seo:       extractSeo(url, html),
    links:     extractLinks(url, html),
    headings:  extractHeadings(html),
    schema:    extractSchema(html),
    openGraph: extractOpenGraph(html),
  };
}
