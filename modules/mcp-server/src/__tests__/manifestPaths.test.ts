import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { resolve } from 'node:path';
import { resolveManifestName, autoManifestName } from '../lib/manifest-paths.js';

describe('resolveManifestName', () => {
  let prevManifestsDir: string | undefined;

  beforeAll(() => {
    prevManifestsDir = process.env['MANIFESTS_DIR'];
    process.env['MANIFESTS_DIR'] = './manifests-test-fixture';
  });

  afterAll(() => {
    if (prevManifestsDir === undefined) delete process.env['MANIFESTS_DIR'];
    else process.env['MANIFESTS_DIR'] = prevManifestsDir;
  });

  it('joins a bare filename against MANIFESTS_DIR', () => {
    const result = resolveManifestName('example.com-2026-01-01.json');
    expect(result).toBe(resolve('./manifests-test-fixture', 'example.com-2026-01-01.json'));
  });

  it('leaves an absolute path untouched', () => {
    const abs = resolve('/tmp/some-manifest.json');
    expect(resolveManifestName(abs)).toBe(abs);
  });

  it('leaves an explicitly relative path (./...) untouched', () => {
    expect(resolveManifestName('./scratch/foo.json')).toBe('./scratch/foo.json');
  });

  it('leaves an explicitly relative path (../...) untouched', () => {
    expect(resolveManifestName('../foo.json')).toBe('../foo.json');
  });
});

describe('autoManifestName', () => {
  it('builds a <host>-<timestamp>.json name resolved against MANIFESTS_DIR', () => {
    const name = autoManifestName('https://example.com/page');
    expect(name).toContain('example.com-');
    expect(name.endsWith('.json')).toBe(true);
    expect(name).not.toContain(':'); // filesystem-safe timestamp
  });

  it('falls back to a generic name for an unparseable seed URL', () => {
    const name = autoManifestName('not a url');
    expect(name).toContain('manifest-');
  });
});
