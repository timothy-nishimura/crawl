import { describe, it, expect } from '@jest/globals';
import { PlaywrightFetchBackend } from '../PlaywrightFetchBackend.js';
import { FetchRequest, SsrfPolicy } from '@crawl/engine';

// These tests exercise the pre-flight SSRF guard only, before the browser
// is launched — no Chromium instance is created, so they run without a
// `playwright install`.
describe('PlaywrightFetchBackend', () => {
  it('instantiates backend with custom SSRF policy', () => {
    const backend = new PlaywrightFetchBackend({ ssrfPolicy: SsrfPolicy.BLOCK_PRIVATE });
    expect(backend).toBeDefined();
  });

  it('blocks private IP addresses via pre-flight check, without launching a browser', async () => {
    const backend = new PlaywrightFetchBackend({ ssrfPolicy: SsrfPolicy.BLOCK_PRIVATE });
    const req = FetchRequest.get('http://127.0.0.1:8080/secret');
    const res = await backend.fetch(req);
    expect(res.statusCode).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('SSRF blocked');
  });

  it('blocks link-local metadata address', async () => {
    const backend = new PlaywrightFetchBackend({ ssrfPolicy: SsrfPolicy.BLOCK_PRIVATE });
    const req = FetchRequest.get('http://169.254.169.254/latest/meta-data');
    const res = await backend.fetch(req);
    expect(res.statusCode).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('SSRF blocked');
  });

  it('rejects non-http(s) schemes via Security.validateUrl before init()', async () => {
    const backend = new PlaywrightFetchBackend({ ssrfPolicy: SsrfPolicy.BLOCK_PRIVATE });
    const req = FetchRequest.get('file:///etc/passwd');
    const res = await backend.fetch(req);
    expect(res.statusCode).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('Only http and https protocols');
  });
});
