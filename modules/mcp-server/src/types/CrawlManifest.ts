/**
 * CrawlManifest — persistent data contract between the crawl/ingest layer
 * and the query layer (search_manifest, summarize_manifest, Claude).
 *
 * Every ingest operation produces one of these on disk. Query tools read
 * slices from it; Claude's context only ever sees the slices, never the
 * raw file.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { Security }                    from '@crawl/engine';

// ── Shared ─────────────────────────────────────────────────────────────────────

export type ManifestSource = 'crawl' | 'sitemap' | 'discovery';

// ── Crawl manifest ────────────────────────────────────────────────────────────

/**
 * A single page record inside a CrawlManifest.
 * Core fields are fixed. Extractor output is stored under the extractor's
 * stable id() key — e.g. `page['mcp.seo']` holds SeoData.
 */
export interface CrawlManifestPage {
  url:         string;
  statusCode:  number;
  depth:       number;
  isDuplicate: boolean;
  /** Extractor outputs, keyed by Extractor.id() */
  [extractorId: string]: unknown;
}

export type CrawlStopReason = 'drained' | 'max_pages' | 'time_limit' | 'interrupted';

/**
 * A URL the engine attempted but could not fetch or process.
 */
export interface PageFailure {
  url:          string;
  errorType:    string;
  errorMessage: string;
}

export interface CrawlManifest {
  meta: {
    source:         'crawl';
    seedUrl:        string;
    createdAt:      string;       // ISO 8601
    pagesCaptured:  number;
    pagesIgnored:   number;
    extractors:     string[];     // extractor id()s that ran
    bypassBot:      boolean;
    durationMs:     number;
    stoppedReason:  CrawlStopReason;
  };
  pages:    CrawlManifestPage[];
  failures: PageFailure[];
}

// ── Sitemap manifest ──────────────────────────────────────────────────────────

export interface SitemapEntry {
  url:         string;
  lastmod?:    string;
  changefreq?: string;
  priority?:   number;
}

export interface SitemapManifest {
  meta: {
    source:     'sitemap';
    sitemapUrl: string;
    createdAt:  string;
    urlCount:   number;
  };
  urls: SitemapEntry[];
}

// ── Discovery manifest ────────────────────────────────────────────────────────

export interface DiscoveryEntry {
  url:      string;
  title:    string;
  snippet?: string;
  date?:    string;
  type?:    string;
  position: number;
}

export interface DiscoveryManifest {
  meta: {
    source:    'discovery';
    domain:    string;
    createdAt: string;
    urlCount:  number;
    provider:  string;
    query:     string;
  };
  results: DiscoveryEntry[];
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type AnyManifest = CrawlManifest | SitemapManifest | DiscoveryManifest;

// ── Save / load helpers ───────────────────────────────────────────────────────

export function saveManifest(path: string, manifest: AnyManifest): void {
  const safePath = Security.sandboxPath(path);
  writeFileSync(safePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

export function loadManifest(path: string): AnyManifest {
  const safePath = Security.sandboxPath(path);
  const raw      = readFileSync(safePath, 'utf-8');
  const parsed   = JSON.parse(raw) as AnyManifest;
  if (!parsed?.meta?.source) {
    throw new Error(`Invalid manifest at ${path}: missing meta.source`);
  }
  return parsed;
}

export function isCrawlManifest(m: AnyManifest): m is CrawlManifest {
  return m.meta.source === 'crawl';
}

export function isSitemapManifest(m: AnyManifest): m is SitemapManifest {
  return m.meta.source === 'sitemap';
}

export function isDiscoveryManifest(m: AnyManifest): m is DiscoveryManifest {
  return m.meta.source === 'discovery';
}
