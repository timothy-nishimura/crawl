import type { Extractor, ParsedPage } from '@crawl/engine';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HeadingEntry {
  /** Heading level: 1–6. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Visible text content, whitespace-collapsed, max 200 chars. */
  text:  string;
}

/** Issues detected in the heading structure. */
export interface HeadingIssues {
  /** True if there are zero H1 tags on the page. */
  missingH1:     boolean;
  /** True if there are two or more H1 tags. */
  multipleH1:    boolean;
  /** True if the first H1 comes after an H2 or deeper heading. */
  h1NotFirst:    boolean;
  /**
   * True if any heading skips a level (e.g. H2 → H4).
   * Skipping is measured in the document order sequence, not globally.
   */
  skippedLevels: boolean;
}

export interface HeadingData {
  /**
   * All H1–H6 elements in document order.
   * Use this for structural analysis: hierarchy, ordering, text quality.
   */
  headings: HeadingEntry[];

  /** Counts per heading level for quick aggregation. */
  counts: {
    h1: number;
    h2: number;
    h3: number;
    h4: number;
    h5: number;
    h6: number;
  };

  /** Pre-computed structural issue flags. */
  issues: HeadingIssues;
}

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Extracts the complete heading hierarchy (H1–H6) from each crawled page.
 *
 * Headings are collected in document order, preserving the full structure
 * needed for hierarchy analysis. Pre-computed issue flags (missingH1,
 * multipleH1, skippedLevels, h1NotFirst) make downstream analysis fast
 * without re-processing the heading array.
 *
 * Output stored in CrawlManifestPage under key 'mcp.headings'.
 */
export class HeadingExtractor implements Extractor<HeadingData> {
  id(): string { return 'mcp.headings'; }

  extract(page: ParsedPage): HeadingData | null {
    const doc = page.document;
    if (!doc) return null;

    const headings: HeadingEntry[] = [];
    const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };

    doc('h1, h2, h3, h4, h5, h6').each((_i, el) => {
      const $el = doc(el);

      // Skip elements hidden from the accessibility tree — these headings are
      // semantically invisible and should not count toward structure analysis.
      // Common pattern: duplicate H1 hidden via aria-hidden for CSS animations.
      if ($el.attr('aria-hidden') === 'true') return;

      const tagName = ($el.prop('tagName') as string).toLowerCase();
      const level   = parseInt(tagName[1]!, 10) as 1 | 2 | 3 | 4 | 5 | 6;
      const text    = $el.text().replace(/\s+/g, ' ').trim().slice(0, 200);

      headings.push({ level, text });
      counts[`h${level}` as keyof typeof counts]++;
    });

    // ── Issue detection ────────────────────────────────────────────────────

    const missingH1  = counts.h1 === 0;
    const multipleH1 = counts.h1 > 1;

    // h1NotFirst: any heading appears before the first H1
    let h1NotFirst = false;
    if (!missingH1) {
      const firstH1Index = headings.findIndex(h => h.level === 1);
      h1NotFirst = firstH1Index > 0;
    }

    // skippedLevels: a heading jumps more than one level deeper than previous
    // e.g. H2 → H4 is a skip; H2 → H3 is fine; ascending is always fine
    let skippedLevels = false;
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1]!.level;
      const curr = headings[i]!.level;
      if (curr > prev + 1) {
        skippedLevels = true;
        break;
      }
    }

    return {
      headings,
      counts,
      issues: { missingH1, multipleH1, h1NotFirst, skippedLevels },
    };
  }
}
