import type { Extractor, ParsedPage } from '@crawl/engine';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Parsed robots directives from <meta name="robots"> and <meta name="googlebot">.
 * A missing tag is treated as "all allowed" — fields default to false.
 */
export interface RobotsDirectives {
  noindex:   boolean;
  nofollow:  boolean;
  noarchive: boolean;
  nosnippet: boolean;
  /** Raw content string for directives not individually parsed. */
  raw: string;
}

export interface HreflangEntry {
  hreflang: string;
  href:     string;
}

export interface OpenGraphData {
  title?:       string;
  description?: string;
  image?:       string;
  url?:         string;
  type?:        string;
  siteName?:    string;
  /** Any og: property not individually mapped, keyed by property name (without "og:"). */
  extra: Record<string, string>;
}

export interface TwitterCardData {
  card?:        string;
  title?:       string;
  description?: string;
  image?:       string;
  site?:        string;
  creator?:     string;
  /** Any twitter: meta not individually mapped. */
  extra: Record<string, string>;
}

export interface MetaData {
  /**
   * Resolved canonical URL from <link rel="canonical">.
   * Null if no canonical tag is present.
   */
  canonical:   string | null;

  /** Parsed robots directives. Null if no robots meta tag is present. */
  robots:      RobotsDirectives | null;

  /** Open Graph metadata. Null if no og: meta tags are present. */
  openGraph:   OpenGraphData | null;

  /** Twitter Card metadata. Null if no twitter: meta tags are present. */
  twitterCard: TwitterCardData | null;

  /**
   * Hreflang alternate link elements.
   * Empty array if none present.
   */
  hreflang:    HreflangEntry[];

  /**
   * Viewport meta content string.
   * Null if no viewport meta tag is present (a mobile-friendliness signal).
   */
  viewport:    string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a comma-separated robots content string into structured directives. */
function parseRobots(content: string): RobotsDirectives {
  const lower = content.toLowerCase();
  const parts = lower.split(',').map(s => s.trim());
  return {
    noindex:   parts.includes('noindex')   || parts.includes('none'),
    nofollow:  parts.includes('nofollow')  || parts.includes('none'),
    noarchive: parts.includes('noarchive'),
    nosnippet: parts.includes('nosnippet'),
    raw:       content.trim(),
  };
}

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Extracts page-level meta signals that affect crawling and indexing:
 *
 * - canonical URL (self-referential or cross-page)
 * - robots directives (noindex, nofollow, noarchive, nosnippet)
 * - Open Graph tags (og:*)
 * - Twitter Card tags (twitter:*)
 * - Hreflang alternate links
 * - Viewport meta
 *
 * Output stored in CrawlManifestPage under key 'mcp.meta'.
 */
export class MetaExtractor implements Extractor<MetaData> {
  id(): string { return 'mcp.meta'; }

  extract(page: ParsedPage): MetaData | null {
    const doc = page.document;
    if (!doc) return null;

    const pageUrl = page.fetchResult.finalUri;

    // ── Canonical ──────────────────────────────────────────────────────────
    let canonical: string | null = null;
    const canonicalRaw = doc('link[rel="canonical"]').attr('href');
    if (canonicalRaw) {
      try {
        canonical = new URL(canonicalRaw, pageUrl).toString();
      } catch {
        canonical = canonicalRaw;
      }
    }

    // ── Robots directives ──────────────────────────────────────────────────
    // Check both <meta name="robots"> and <meta name="googlebot">
    let robots: RobotsDirectives | null = null;
    const robotsContent =
      doc('meta[name="robots"]').attr('content') ??
      doc('meta[name="googlebot"]').attr('content');
    if (robotsContent !== undefined) {
      robots = parseRobots(robotsContent);
    }

    // ── Open Graph ─────────────────────────────────────────────────────────
    let openGraph: OpenGraphData | null = null;
    const ogMapped: Record<string, string> = {};

    // Primary: spec-compliant property="og:*" (Facebook / Open Graph spec)
    doc('meta[property^="og:"]').each((_i, el) => {
      const prop    = doc(el).attr('property') ?? '';
      const content = doc(el).attr('content')  ?? '';
      const key     = prop.slice(3); // strip "og:"
      // Guard: skip prototype-poisoning keys that could mutate Object.prototype
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      ogMapped[key] = content;
    });

    // Fallback: name="og:*" — incorrect but common in WordPress plugins.
    // Only fills in keys not already set by the property= variant.
    doc('meta[name^="og:"]').each((_i, el) => {
      const name    = doc(el).attr('name')    ?? '';
      const content = doc(el).attr('content') ?? '';
      const key     = name.slice(3); // strip "og:"
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      if (!(key in ogMapped)) ogMapped[key] = content;
    });

    if (Object.keys(ogMapped).length > 0) {
      const { title, description, image, url, type, 'site_name': siteName, ...rest } = ogMapped;
      openGraph = {
        ...(title       !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(image       !== undefined && { image }),
        ...(url         !== undefined && { url }),
        ...(type        !== undefined && { type }),
        ...(siteName    !== undefined && { siteName }),
        extra: rest,
      };
    }

    // ── Twitter Card ───────────────────────────────────────────────────────
    let twitterCard: TwitterCardData | null = null;
    const twMapped: Record<string, string> = {};

    doc('meta[name^="twitter:"]').each((_i, el) => {
      const name    = doc(el).attr('name')    ?? '';
      const content = doc(el).attr('content') ?? '';
      const key     = name.slice(8); // strip "twitter:"
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      twMapped[key] = content;
    });

    if (Object.keys(twMapped).length > 0) {
      const { card, title, description, image, site, creator, ...rest } = twMapped;
      twitterCard = {
        ...(card        !== undefined && { card }),
        ...(title       !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(image       !== undefined && { image }),
        ...(site        !== undefined && { site }),
        ...(creator     !== undefined && { creator }),
        extra: rest,
      };
    }

    // ── Hreflang ───────────────────────────────────────────────────────────
    const hreflang: HreflangEntry[] = [];
    doc('link[rel="alternate"][hreflang]').each((_i, el) => {
      const lang = doc(el).attr('hreflang') ?? '';
      const href = doc(el).attr('href')     ?? '';
      if (lang && href) {
        let resolvedHref: string;
        try {
          resolvedHref = new URL(href, pageUrl).toString();
        } catch {
          resolvedHref = href;
        }
        hreflang.push({ hreflang: lang, href: resolvedHref });
      }
    });

    // ── Viewport ───────────────────────────────────────────────────────────
    const viewport = doc('meta[name="viewport"]').attr('content') ?? null;

    return { canonical, robots, openGraph, twitterCard, hreflang, viewport };
  }
}
