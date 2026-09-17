import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync }  from 'node:fs';
import { tmpdir }               from 'node:os';
import { join }                 from 'node:path';
import { Security }             from '../Security.js';

describe('Security.sandboxPath', () => {
  let tmpRoot: string;
  let prevScratch: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crawl-security-test-'));
    prevScratch = process.env['SCRATCH_DIR'];
    process.env['SCRATCH_DIR'] = join(tmpRoot, 'scratch');
  });

  afterAll(() => {
    if (prevScratch === undefined) delete process.env['SCRATCH_DIR'];
    else process.env['SCRATCH_DIR'] = prevScratch;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws for an empty path', () => {
    expect(() => Security.sandboxPath('')).toThrow(/Invalid or empty path/);
  });

  it('throws for a non-string path', () => {
    expect(() => Security.sandboxPath(undefined as unknown as string)).toThrow(/Invalid or empty path/);
  });

  it('resolves a plain filename inside the default scratch root', () => {
    const result = Security.sandboxPath('page.html');
    expect(result.startsWith(join(tmpRoot, 'scratch'))).toBe(true);
  });

  it('rejects path traversal that escapes every sandbox root', () => {
    expect(() => Security.sandboxPath('../../../../etc/passwd')).toThrow(/Path traversal detected/);
  });

  it('resolves a path inside an explicit sandbox root', () => {
    const root = join(tmpRoot, 'custom');
    const result = Security.sandboxPath('sub/file.json', root);
    expect(result.startsWith(root)).toBe(true);
  });

  it('rejects a path outside an explicit sandbox root', () => {
    const root = join(tmpRoot, 'custom');
    expect(() => Security.sandboxPath('../../outside.json', root)).toThrow(/Path traversal detected/);
  });
});

describe('Security.validateUrl', () => {
  it('allows http URLs', () => {
    expect(() => Security.validateUrl('http://example.com/page')).not.toThrow();
  });

  it('allows https URLs', () => {
    expect(() => Security.validateUrl('https://example.com/page')).not.toThrow();
  });

  it('rejects file: URLs', () => {
    expect(() => Security.validateUrl('file:///etc/passwd')).toThrow(/Only http and https protocols/);
  });

  it('rejects ftp: URLs', () => {
    expect(() => Security.validateUrl('ftp://example.com/file')).toThrow(/Only http and https protocols/);
  });

  it('rejects malformed URLs', () => {
    expect(() => Security.validateUrl('not a url')).toThrow(/Invalid URL/);
  });
});
