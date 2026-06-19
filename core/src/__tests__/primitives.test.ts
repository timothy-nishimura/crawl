/**
 * Unit tests for the small, self-contained value types and support classes:
 * FetchRequest, FetchResult, InMemoryFrontier, BodyDeduplicator, UrlNormalizer.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { FetchRequest }      from '../FetchRequest.js';
import { FetchResult }       from '../FetchResult.js';
import { InMemoryFrontier }  from '../InMemoryFrontier.js';
import { BodyDeduplicator }  from '../BodyDeduplicator.js';
import { UrlNormalizer }     from '../UrlNormalizer.js';

const enc = new TextEncoder();

// ── FetchRequest ──────────────────────────────────────────────────────────────

describe('FetchRequest', () => {

  it('FetchRequest.get creates a GET with defaults', () => {
    const r = FetchRequest.get('https://example.com');
    expect(r.method).toBe('GET');
    expect(r.uri).toBe('https://example.com');
    expect(r.followRedirects).toBe(true);
    expect(r.maxBodyBytes).toBe(FetchRequest.DEFAULT_MAX_BODY_BYTES);
  });

  it('FetchRequest.head creates a HEAD with zero body limit', () => {
    const r = FetchRequest.head('https://example.com');
    expect(r.method).toBe('HEAD');
    expect(r.maxBodyBytes).toBe(0);
  });

  it('builder allows override of every field', () => {
    const r = FetchRequest.builder('https://example.com')
      .method('HEAD')
      .header('Accept', 'text/html')
      .timeoutMs(5_000)
      .maxRedirects(3)
      .followRedirects(false)
      .maxBodyBytes(1024)
      .build();

    expect(r.method).toBe('HEAD');
    expect(r.headers['Accept']).toBe('text/html');
    expect(r.timeoutMs).toBe(5_000);
    expect(r.maxRedirects).toBe(3);
    expect(r.followRedirects).toBe(false);
    expect(r.maxBodyBytes).toBe(1024);
  });

  it('builder is frozen', () => {
    const r = FetchRequest.builder('https://example.com').build();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.headers)).toBe(true);
  });

  it('headers() replaces all headers; header() adds one', () => {
    const r1 = FetchRequest.builder('https://example.com')
      .headers({ A: '1', B: '2' })
      .build();
    expect(r1.headers['A']).toBe('1');
    expect(r1.headers['B']).toBe('2');

    const r2 = FetchRequest.builder('https://example.com')
      .header('X-Custom', 'hello')
      .build();
    expect(r2.headers['X-Custom']).toBe('hello');
  });
});

// ── FetchResult ───────────────────────────────────────────────────────────────

describe('FetchResult', () => {

  const makeResult = (overrides: Partial<{
    status: number; body: string; contentType: string; charset: string;
  }> = {}) =>
    FetchResult.builder('https://example.com')
      .finalUri('https://example.com')
      .statusCode(overrides.status ?? 200)
      .contentType(overrides.contentType ?? 'text/html')
      .charset(overrides.charset ?? 'utf-8')
      .body(enc.encode(overrides.body ?? '<html></html>'))
      .build();

  it('isSuccess returns true for 2xx', () => {
    expect(FetchResult.isSuccess(makeResult({ status: 200 }))).toBe(true);
    expect(FetchResult.isSuccess(makeResult({ status: 204 }))).toBe(true);
  });

  it('isSuccess returns false for non-2xx', () => {
    expect(FetchResult.isSuccess(makeResult({ status: 301 }))).toBe(false);
    expect(FetchResult.isSuccess(makeResult({ status: 404 }))).toBe(false);
  });

  it('isFetchError detects network errors', () => {
    const err = FetchResult.fromError('https://example.com', new Error('timeout'));
    expect(FetchResult.isFetchError(err)).toBe(true);
    expect(err.statusCode).toBe(0);
  });

  it('isRedirect returns true for 3xx', () => {
    expect(FetchResult.isRedirect(makeResult({ status: 301 }))).toBe(true);
    expect(FetchResult.isRedirect(makeResult({ status: 302 }))).toBe(true);
    expect(FetchResult.isRedirect(makeResult({ status: 200 }))).toBe(false);
  });

  it('isHtml detects text/html content type', () => {
    expect(FetchResult.isHtml(makeResult({ contentType: 'text/html' }))).toBe(true);
    expect(FetchResult.isHtml(makeResult({ contentType: 'application/json' }))).toBe(false);
  });

  it('bodyText decodes the body using the result charset', () => {
    const r = makeResult({ body: 'hello world', charset: 'utf-8' });
    expect(FetchResult.bodyText(r)).toBe('hello world');
  });

  it('header returns the first value for a response header (case-insensitive)', () => {
    const r = FetchResult.builder('https://example.com')
      .responseHeaders({ 'content-type': ['text/html; charset=utf-8'] })
      .build();
    expect(FetchResult.header(r, 'Content-Type')).toBe('text/html; charset=utf-8');
    expect(FetchResult.header(r, 'content-type')).toBe('text/html; charset=utf-8');
    expect(FetchResult.header(r, 'x-missing')).toBeUndefined();
  });

  it('finalUri defaults to requestUri when not set', () => {
    const r = FetchResult.builder('https://example.com').build();
    expect(r.finalUri).toBe('https://example.com');
  });

  it('fromError sets error and statusCode=0', () => {
    const e = new Error('connection refused');
    const r = FetchResult.fromError('https://example.com', e);
    expect(r.error).toBe(e);
    expect(r.statusCode).toBe(0);
    expect(r.requestUri).toBe('https://example.com');
  });
});

// ── InMemoryFrontier ──────────────────────────────────────────────────────────

describe('InMemoryFrontier', () => {

  it('returns the submitted URL from next()', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    const entry = f.next();
    expect(entry?.url).toBe('https://example.com');
    expect(entry?.depth).toBe(0);
  });

  it('deduplicates URLs — second submit is ignored', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    f.submit('https://example.com', 0);
    expect(f.queueSize()).toBe(1);
  });

  it('deduplicates across fragments', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com/page', 0);
    f.submit('https://example.com/page#section', 0);
    expect(f.queueSize()).toBe(1);
  });

  it('does not re-enqueue a URL that was already in-flight', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    f.next(); // moves to in-flight
    f.submit('https://example.com', 0); // should be a no-op
    expect(f.queueSize()).toBe(0);
    expect(f.inFlightCount()).toBe(1);
  });

  it('isDrained returns false while items are queued', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    expect(f.isDrained()).toBe(false);
  });

  it('isDrained returns false while items are in-flight', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    f.next();
    expect(f.isDrained()).toBe(false);
  });

  it('isDrained returns true after all items complete', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com', 0);
    const entry = f.next()!;
    f.complete(entry.url);
    expect(f.isDrained()).toBe(true);
  });

  it('next() returns null when queue is empty', () => {
    const f = new InMemoryFrontier();
    expect(f.next()).toBeNull();
  });

  it('queueSize and inFlightCount track correctly', () => {
    const f = new InMemoryFrontier();
    f.submit('https://example.com/a', 0);
    f.submit('https://example.com/b', 0);
    expect(f.queueSize()).toBe(2);
    expect(f.inFlightCount()).toBe(0);

    f.next();
    expect(f.queueSize()).toBe(1);
    expect(f.inFlightCount()).toBe(1);

    const entry = f.next()!;
    f.complete(entry.url);
    expect(f.queueSize()).toBe(0);
    expect(f.inFlightCount()).toBe(1);
  });
});

// ── BodyDeduplicator ──────────────────────────────────────────────────────────

describe('BodyDeduplicator', () => {

  it('returns false for the first occurrence of a body', () => {
    const d = new BodyDeduplicator();
    expect(d.isDuplicate(enc.encode('hello'))).toBe(false);
  });

  it('returns true for a duplicate body', () => {
    const d = new BodyDeduplicator();
    d.isDuplicate(enc.encode('hello'));
    expect(d.isDuplicate(enc.encode('hello'))).toBe(true);
  });

  it('distinguishes bodies with different content', () => {
    const d = new BodyDeduplicator();
    expect(d.isDuplicate(enc.encode('page-a'))).toBe(false);
    expect(d.isDuplicate(enc.encode('page-b'))).toBe(false);
  });

  it('always returns false for an empty body', () => {
    const d = new BodyDeduplicator();
    expect(d.isDuplicate(new Uint8Array(0))).toBe(false);
    expect(d.isDuplicate(new Uint8Array(0))).toBe(false);
  });

  it('reset clears the seen set', () => {
    const d = new BodyDeduplicator();
    d.isDuplicate(enc.encode('hello'));
    d.reset();
    expect(d.isDuplicate(enc.encode('hello'))).toBe(false);
  });
});

// ── UrlNormalizer ─────────────────────────────────────────────────────────────

describe('UrlNormalizer', () => {

  const norm = new UrlNormalizer(true); // stripSessionParams = true

  it('resolves a relative path against the base', () => {
    expect(norm.resolve('https://example.com/dir/', 'page.html'))
      .toBe('https://example.com/dir/page.html');
  });

  it('resolves an absolute-path href', () => {
    expect(norm.resolve('https://example.com/dir/', '/about'))
      .toBe('https://example.com/about');
  });

  it('resolves a full URL unchanged', () => {
    expect(norm.resolve('https://example.com/', 'https://other.com/page'))
      .toBe('https://other.com/page');
  });

  it('strips URL fragment', () => {
    const result = norm.resolve('https://example.com/', '/page#section');
    expect(result).toBe('https://example.com/page');
  });

  it('strips session-like query params when stripSessionParams is true', () => {
    const url = 'https://example.com/page?PHPSESSID=abc123&q=test';
    const result = norm.resolve('https://example.com/', url);
    expect(result).not.toContain('PHPSESSID');
    expect(result).toContain('q=test');
  });

  it('returns null for non-http/https schemes', () => {
    expect(norm.resolve('https://example.com/', 'mailto:user@example.com')).toBeNull();
    expect(norm.resolve('https://example.com/', 'javascript:void(0)')).toBeNull();
  });

  it('returns null for an unparseable href', () => {
    // An href that is invalid even after resolution should return null.
    expect(norm.resolve('https://example.com/', '')).toBeNull();
  });
});
