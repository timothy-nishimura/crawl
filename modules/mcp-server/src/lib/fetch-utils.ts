/**
 * Shared fetch helpers used by fetch_page and fetch_api tools.
 */

import {
  HttpClientBackend,
  FetchRequest,
  FetchResult,
  SsrfPolicy,
} from '@crawl/engine';
import type { FetchBackend } from '@crawl/engine';
import { TlsFetchBackend }   from '../backends/TlsFetchBackend.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type FetchResultInstance = ReturnType<typeof FetchResult.fromError>;

// ── Constants ──────────────────────────────────────────────────────────────────

export const MAX_REDIRECTS = 10;

// ── Cloudflare / bot-wall detection ───────────────────────────────────────────

export function isCloudflareBlock(result: FetchResultInstance): boolean {
  if (FetchResult.isFetchError(result)) return false;
  if (result.statusCode !== 403 && result.statusCode !== 503) return false;
  return FetchResult.header(result, 'cf-ray') !== undefined;
}

// ── Redirect-following fetch ───────────────────────────────────────────────────
//
// HttpClientBackend always returns raw 3xx responses (redirect: 'manual') so
// CrawlEngine can route them through its frontier/robots/rate-limit pipeline.
// For single-shot tools we want transparent redirect following, so we implement
// it manually here.

export async function fetchFollowingRedirects(
  startUrl:     string,
  maxBodyBytes: number,
  timeoutMs:    number,
  backend:      FetchBackend,
  extraHeaders: Record<string, string> = {},
): Promise<FetchResultInstance> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const request = FetchRequest.builder(currentUrl)
      .method('GET')
      .headers(extraHeaders)
      .timeoutMs(timeoutMs)
      .maxBodyBytes(maxBodyBytes)
      .build();

    const result = await backend.fetch(request);

    // Success or non-redirect error — return as-is
    if (!FetchResult.isRedirect(result)) return result;

    // Extract and resolve the Location header
    const location = FetchResult.header(result, 'location');
    if (!location) return result;  // malformed redirect — return the 3xx

    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      return result;  // unparseable Location — return the 3xx
    }
  }

  return FetchResult.fromError(
    startUrl,
    new Error(`Too many redirects (> ${MAX_REDIRECTS}) from ${startUrl}`),
  );
}

// ── Backend factory with optional Cloudflare bypass ───────────────────────────
//
// Creates an HttpClientBackend, probes the seed URL, and auto-upgrades to
// TlsFetchBackend if a Cloudflare block is detected.  Returns the backend and
// a flag indicating whether bypass was activated.

export async function createBackend(
  seedUrl:    string,
  bypassBot:  boolean,
  timeoutMs:  number,
): Promise<{ backend: FetchBackend; autoBypass: boolean }> {
  if (bypassBot) {
    const backend = await TlsFetchBackend.create();
    return { backend, autoBypass: true };
  }

  const probeBackend = HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE);
  let needsBypass = false;
  try {
    const req    = FetchRequest.builder(seedUrl).timeoutMs(timeoutMs).build();
    const result = await probeBackend.fetch(req);
    if (result.statusCode === 403 && FetchResult.header(result, 'cf-ray') !== undefined) {
      needsBypass = true;
    }
  } finally {
    await probeBackend.close();
  }

  if (needsBypass) {
    try {
      const backend = await TlsFetchBackend.create();
      return { backend, autoBypass: true };
    } catch {
      // TLS backend unavailable — fall through to plain backend
    }
  }

  return { backend: HttpClientBackend.create(SsrfPolicy.BLOCK_PRIVATE), autoBypass: false };
}

// ── JSON path helper ───────────────────────────────────────────────────────────
//
// Traverses an object using a dot-separated path string.
// Returns undefined if any segment is missing.

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key: string) => {
    if (acc !== null && acc !== undefined && typeof acc === 'object' && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ── Single-shot POST fetch (no redirect following) ─────────────────────────────
//
// Used by fetch_api when method=POST. POST redirects (302/303) would silently
// convert to GET — unexpected behaviour for API callers — so we don't follow
// them here. The caller gets the raw response regardless of status code.

export async function fetchOnce(
  url:          string,
  maxBodyBytes: number,
  timeoutMs:    number,
  backend:      FetchBackend,
  extraHeaders: Record<string, string> = {},
  method:       'GET' | 'POST'         = 'POST',
  body?:        string,
): Promise<FetchResultInstance> {
  const builder = FetchRequest.builder(url)
    .method(method)
    .headers(extraHeaders)
    .timeoutMs(timeoutMs)
    .maxBodyBytes(maxBodyBytes);

  if (body !== undefined) {
    builder.body(body);
  }

  return backend.fetch(builder.build());
}

// ── Sleep ──────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
