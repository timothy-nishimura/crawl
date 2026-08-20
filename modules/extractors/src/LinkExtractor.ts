import { load } from 'cheerio';
import { FetchResult, type Extractor, type ParsedPage } from '@crawl/engine';

export interface LinkEntry {
  href:   string;
  anchor: string;
  rel?: 'nofollow' | 'sponsored' | 'ugc';
}

export interface LinkData {
  internal: LinkEntry[];
  external: LinkEntry[];
}

export class LinkExtractor implements Extractor<LinkData> {
  id(): string { return 'mcp.links'; }

  extract(page: ParsedPage): LinkData | null {
    const html = FetchResult.bodyText(page.fetchResult);
    if (!html) return null;
    
    const $ = load(html);
    const links = $('a[href]');
    
    const pageUrl = page.fetchResult.finalUri;
    let pageOrigin: string;
    try {
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      return null;
    }

    const internal: LinkEntry[] = [];
    const external: LinkEntry[] = [];
    const seen = new Set<string>();

    links.each((_i, el) => {
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
        const u = new URL(rawHref, pageUrl);
        u.hash = '';
        resolved = u.toString();
      } catch {
        return;
      }

      if (seen.has(resolved)) return;
      seen.add(resolved);

      const anchor  = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 100);
      const relAttr = ($(el).attr('rel') ?? '').toLowerCase();
      const relParts = relAttr.split(/\s+/);
      const rel: LinkEntry['rel'] =
        relParts.includes('sponsored') ? 'sponsored' :
        relParts.includes('ugc')       ? 'ugc'       :
        relParts.includes('nofollow')  ? 'nofollow'  :
        undefined;

      const entry: LinkEntry = {
        href: resolved,
        anchor,
        ...(rel !== undefined && { rel }),
      };

      try {
        const linkOrigin = new URL(resolved).origin;
        if (linkOrigin === pageOrigin) {
          internal.push(entry);
        } else {
          external.push(entry);
        }
      } catch {
      }
    });

    return { internal, external };
  }
}
