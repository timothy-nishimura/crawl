import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listManifests } from '../tools/listManifests.js';

/**
 * Regression test for a gap found while manually verifying the live
 * crawl-operator plugin: fetch_page's autoManifest save writes a flat
 * {url, statusCode, title, ...} result (no meta.source), so
 * loadManifest() rejects it as not-an-AnyManifest and the old
 * list_manifests silently dropped it — an operator who just fetched a
 * page and got a savedTo path back would never find it again via
 * list_manifests, defeating the entire point of that tool existing.
 */
describe('listManifests', () => {
  let tmpRoot: string;
  let prevManifestsDir: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crawl-listmanifests-test-'));
    prevManifestsDir = process.env['MANIFESTS_DIR'];
    process.env['MANIFESTS_DIR'] = tmpRoot;
  });

  afterAll(() => {
    if (prevManifestsDir === undefined) delete process.env['MANIFESTS_DIR'];
    else process.env['MANIFESTS_DIR'] = prevManifestsDir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list when the directory has no files', () => {
    expect(listManifests()).toEqual([]);
  });

  it('lists a fetch_page autoManifest save (flat result, no meta.source)', () => {
    writeFileSync(
      join(tmpRoot, 'example.com-2026-01-01T00-00-00-000Z.json'),
      JSON.stringify({
        url: 'https://example.com/',
        statusCode: 200,
        title: 'Example Domain',
        byline: null,
        publishedTime: null,
        siteName: null,
        excerpt: 'An example page.',
        length: 42,
        truncated: false,
        content: 'An example page.',
      }),
    );

    const result = listManifests();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'fetch_page',
      url: 'https://example.com/',
      title: 'Example Domain',
      statusCode: 200,
    });
  });

  it('lists a real crawl manifest alongside a fetch_page result, sorted newest first', () => {
    writeFileSync(
      join(tmpRoot, 'crawl-manifest.json'),
      JSON.stringify({
        meta: {
          source: 'crawl',
          seedUrl: 'https://example.org/',
          createdAt: '2099-01-01T00:00:00.000Z', // far in the future — must sort first
          pagesCaptured: 3,
          pagesIgnored: 0,
          extractors: ['mcp.seo'],
          bypassBot: false,
          durationMs: 100,
          stoppedReason: 'drained',
        },
        pages: [],
        failures: [],
      }),
    );

    const result = listManifests();
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toMatchObject({ source: 'crawl', seedUrl: 'https://example.org/' });
    expect(result.some(m => m.source === 'fetch_page')).toBe(true);
  });

  it('skips a corrupt/unrecognized JSON file without throwing', () => {
    writeFileSync(join(tmpRoot, 'garbage.json'), '{"not": "a manifest or a fetch result"}');
    expect(() => listManifests()).not.toThrow();
  });
});
