/**
 * CrawlManifest now lives in @crawl/engine (core/src/CrawlManifest.ts) — it's
 * the shared data contract between the crawl/ingest layer and the query
 * layer, so anyone consuming @crawl/engine as a library gets the format its
 * output is written in along with the engine itself. Re-exported here so
 * existing import sites don't need to move.
 */
export {
  type ManifestSource,
  type CrawlManifestPage,
  type CrawlStopReason,
  type PageFailure,
  type CrawlManifest,
  type SitemapEntry,
  type SitemapManifest,
  type DiscoveryEntry,
  type DiscoveryManifest,
  type AnyManifest,
  saveManifest,
  loadManifest,
  isCrawlManifest,
  isSitemapManifest,
  isDiscoveryManifest,
} from '@crawl/engine';
