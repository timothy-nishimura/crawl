import type { Extractor, ParsedPage } from '@crawl/engine';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Alt text status — three distinct states, each with different SEO implications.
 *
 * - 'missing'    — no alt attribute present. Screen readers read the filename;
 *                  search engines may try to infer context but it's unreliable.
 * - 'decorative' — alt="" explicitly set. Correct for spacers/icons; wrong for
 *                  meaningful images.
 * - 'present'    — alt attribute has non-empty text. Ideal for content images.
 */
export type AltStatus = 'missing' | 'decorative' | 'present';

export interface ImageEntry {
  /** Resolved absolute URL of the image src. */
  src:       string;
  /** Alt attribute status. */
  altStatus: AltStatus;
  /** Alt text value (empty string when decorative, undefined when missing). */
  alt?:      string;
  /** Declared width in pixels (from attribute, not computed style). */
  width?:    number;
  /** Declared height in pixels (from attribute, not computed style). */
  height?:   number;
  /** loading="lazy" | "eager" | undefined — lazy loading adoption signal. */
  loading?:  'lazy' | 'eager';
  /**
   * True when the src was resolved from a srcset descriptor rather than
   * a plain src attribute. Informational — does not affect alt coverage counts.
   */
  fromSrcset?: true;
}

export interface ImageData {
  /** All images on the page with resolved src and alt analysis. */
  images: ImageEntry[];

  /** Summary counts for alt coverage and lazy loading adoption. */
  counts: {
    total:      number;
    missing:    number;  // altStatus === 'missing'  (on non-srcset entries)
    decorative: number;  // altStatus === 'decorative'
    present:    number;  // altStatus === 'present'
    lazyLoaded: number;  // loading="lazy"
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns the first URL from a srcset descriptor string, or null.
 *
 * srcset format: "url1 [w/x descriptor], url2 [descriptor], …"
 * We only need the first URL — sufficient for alt and existence analysis.
 */
function firstUrlFromSrcset(srcset: string): string | null {
  const first = srcset.trim().split(',')[0];
  if (!first) return null;
  const url = first.trim().split(/\s+/)[0];
  return url || null;
}

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Extracts all images from each crawled page, covering modern responsive formats:
 *
 * - <img src>                      — standard
 * - <img srcset>                   — responsive (srcset only, no src)
 * - <img data-src / data-lazy-src> — lazy-loaded images
 * - <picture><source srcset>       — art-direction responsive images
 *
 * Alt text is analysed on <img> elements only — <picture><source> entries
 * do not carry alt attributes (their <img> sibling does). Coverage counts
 * therefore exclude fromSrcset=true entries to avoid double-counting.
 *
 * Output stored in CrawlManifestPage under key 'mcp.images'.
 */
export class ImageExtractor implements Extractor<ImageData> {
  id(): string { return 'mcp.images'; }

  extract(page: ParsedPage): ImageData | null {
    const doc = page.document;
    if (!doc) return null;

    const pageUrl = page.fetchResult.finalUri;
    const images: ImageEntry[] = [];
    const seenSrc = new Set<string>();

    // ── <img> elements ─────────────────────────────────────────────────────
    doc('img').each((_i, el) => {
      const $el = doc(el);

      // Resolve src: explicit src → srcset first candidate → lazy attrs
      let rawSrc: string | undefined;
      let fromSrcset = false;

      rawSrc = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src');

      if (!rawSrc) {
        const srcset = $el.attr('srcset') || $el.attr('data-srcset');
        if (srcset) {
          const candidate = firstUrlFromSrcset(srcset);
          if (candidate) { rawSrc = candidate; fromSrcset = true; }
        }
      }

      if (!rawSrc) return;

      let src: string;
      try { src = new URL(rawSrc, pageUrl).toString(); }
      catch { return; }

      if (src.startsWith('data:')) return;
      if (seenSrc.has(src)) return;
      seenSrc.add(src);

      // Alt text
      const altAttr = $el.attr('alt');
      let altStatus: AltStatus;
      let alt: string | undefined;
      if (altAttr === undefined) {
        altStatus = 'missing';
      } else if (altAttr.trim() === '') {
        altStatus = 'decorative'; alt = '';
      } else {
        altStatus = 'present'; alt = altAttr.trim().slice(0, 200);
      }

      // Dimensions
      const widthAttr  = $el.attr('width');
      const heightAttr = $el.attr('height');
      const width      = widthAttr  ? parseInt(widthAttr,  10) || undefined : undefined;
      const height     = heightAttr ? parseInt(heightAttr, 10) || undefined : undefined;

      // Loading
      const loadingAttr = $el.attr('loading');
      const loading: 'lazy' | 'eager' | undefined =
        loadingAttr === 'lazy'  ? 'lazy'  :
        loadingAttr === 'eager' ? 'eager' :
        undefined;

      images.push({
        src, altStatus,
        ...(alt        !== undefined && { alt }),
        ...(width      !== undefined && { width }),
        ...(height     !== undefined && { height }),
        ...(loading    !== undefined && { loading }),
        ...(fromSrcset             && { fromSrcset: true as const }),
      });
    });

    // ── <picture><source> elements ─────────────────────────────────────────
    // Captures art-direction <source> candidates whose srcset URL is distinct
    // from the sibling <img> fallback already recorded above.
    // These do not carry alt attributes — marked decorative to exclude from
    // alt coverage counts (alt responsibility is on the sibling <img>).
    doc('picture source[srcset], picture source[data-srcset]').each((_i, el) => {
      const $el    = doc(el);
      const srcset = $el.attr('srcset') || $el.attr('data-srcset') || '';
      const rawSrc = firstUrlFromSrcset(srcset);
      if (!rawSrc) return;

      let src: string;
      try { src = new URL(rawSrc, pageUrl).toString(); }
      catch { return; }

      if (src.startsWith('data:')) return;
      if (seenSrc.has(src)) return;
      seenSrc.add(src);

      images.push({ src, altStatus: 'decorative', alt: '', fromSrcset: true });
    });

    // ── Counts ────────────────────────────────────────────────────────────
    // Alt coverage counts exclude fromSrcset entries (<picture><source>)
    // since their alt is on the sibling <img>, already counted above.
    const coverageImages = images.filter(i => !i.fromSrcset);
    const counts = {
      total:      coverageImages.length,
      missing:    coverageImages.filter(i => i.altStatus === 'missing').length,
      decorative: coverageImages.filter(i => i.altStatus === 'decorative').length,
      present:    coverageImages.filter(i => i.altStatus === 'present').length,
      lazyLoaded: images.filter(i => i.loading === 'lazy').length,
    };

    return { images, counts };
  }
}
