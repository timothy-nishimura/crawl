import { describe, it, expect } from '@jest/globals';
import { TlsFetchBackend } from '../TlsFetchBackend.js';
import { FetchRequest, SsrfPolicy } from '@crawl/engine';

describe('TlsFetchBackend', () => {
  it('instantiates backend with custom SSRF policy', async () => {
    const backend = new TlsFetchBackend(SsrfPolicy.BLOCK_PRIVATE);
    expect(backend).toBeDefined();
  });

  it('blocks private IP addresses via pre-flight check', async () => {
    const backend = new TlsFetchBackend(SsrfPolicy.BLOCK_PRIVATE);
    const req = FetchRequest.get('http://127.0.0.1:8080/secret');
    const res = await backend.fetch(req);
    expect(res.statusCode).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('SSRF blocked');
  });

  it('blocks link-local metadata address', async () => {
    const backend = new TlsFetchBackend(SsrfPolicy.BLOCK_PRIVATE);
    const req = FetchRequest.get('http://169.254.169.254/latest/meta-data');
    const res = await backend.fetch(req);
    expect(res.statusCode).toBe(0);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('SSRF blocked');
  });
});
