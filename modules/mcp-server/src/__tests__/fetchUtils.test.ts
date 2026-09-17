import { describe, it, expect } from '@jest/globals';
import { FetchRequest, FetchResult, type FetchBackend } from '@crawl/engine';
import { fetchFollowingRedirects } from '../lib/fetch-utils.js';

/**
 * Regression test for the credential-leak-on-redirect fix: fetchFollowingRedirects
 * used to reuse the caller-supplied headers object unchanged across every
 * redirect hop, including cross-origin ones — an Authorization/Cookie header
 * meant for the original host would be replayed to whatever host a 3xx
 * response pointed at. SSRF-on-redirect is already covered by each backend's
 * SsrfGuard connector re-checking every hop; this is purely about the
 * credential headers themselves.
 */
type MockBackend = FetchBackend & { __received: Record<string, Record<string, string>> };

function mockBackend(responses: Record<string, () => FetchResult>): MockBackend {
  const received: Record<string, Record<string, string>> = {};
  return {
    async fetch(request: FetchRequest): Promise<FetchResult> {
      received[request.uri] = { ...request.headers };
      const make = responses[request.uri];
      if (!make) throw new Error(`mockBackend: no response configured for ${request.uri}`);
      return make();
    },
    close() {},
    __received: received,
  };
}

function redirectTo(location: string) {
  return () => FetchResult.builder('')
    .statusCode(302)
    .responseHeaders({ location: [location] })
    .build();
}

function okResult() {
  return () => FetchResult.builder('')
    .statusCode(200)
    .responseHeaders({ 'content-type': ['text/html'] })
    .body(new TextEncoder().encode('<html></html>'))
    .build();
}

describe('fetchFollowingRedirects — credential headers on redirect', () => {
  it('strips Authorization/Cookie/Proxy-Authorization on a cross-origin redirect', async () => {
    const backend = mockBackend({
      'https://a.example/start': redirectTo('https://b.example/final'),
      'https://b.example/final': okResult(),
    });

    await fetchFollowingRedirects(
      'https://a.example/start',
      1_000_000,
      5000,
      backend,
      { Authorization: 'Bearer secret', Cookie: 'session=abc', 'Proxy-Authorization': 'Basic xyz', 'X-Custom': 'keep-me' },
    );

    const firstHopHeaders = backend.__received['https://a.example/start']!;
    expect(firstHopHeaders['Authorization']).toBe('Bearer secret');

    const secondHopHeaders = backend.__received['https://b.example/final']!;
    expect(secondHopHeaders['Authorization']).toBeUndefined();
    expect(secondHopHeaders['Cookie']).toBeUndefined();
    expect(secondHopHeaders['Proxy-Authorization']).toBeUndefined();
    expect(secondHopHeaders['X-Custom']).toBe('keep-me');
  });

  it('keeps credential headers across a same-origin redirect', async () => {
    const backend = mockBackend({
      'https://a.example/start': redirectTo('https://a.example/final'),
      'https://a.example/final': okResult(),
    });

    await fetchFollowingRedirects(
      'https://a.example/start',
      1_000_000,
      5000,
      backend,
      { Authorization: 'Bearer secret' },
    );

    const secondHopHeaders = backend.__received['https://a.example/final']!;
    expect(secondHopHeaders['Authorization']).toBe('Bearer secret');
  });

  it('does not mutate the caller-supplied headers object', async () => {
    const backend = mockBackend({
      'https://a.example/start': redirectTo('https://b.example/final'),
      'https://b.example/final': okResult(),
    });

    const callerHeaders = { Authorization: 'Bearer secret' };
    await fetchFollowingRedirects('https://a.example/start', 1_000_000, 5000, backend, callerHeaders);

    expect(callerHeaders['Authorization']).toBe('Bearer secret');
  });
});
