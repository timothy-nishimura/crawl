import { describe, it, expect } from '@jest/globals';
import { CrawlConfig } from '../CrawlConfig.js';
import { SsrfPolicy }  from '../SsrfPolicy.js';

const seed = 'https://example.com';

describe('CrawlConfig.Builder — construction', () => {

  it('accepts a valid https seed URL', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.seedUrl).toBe(seed);
    expect(cfg.domain).toBe('example.com');
  });

  it('strips www. from domain', () => {
    const cfg = CrawlConfig.builder('https://www.example.com').build();
    expect(cfg.domain).toBe('example.com');
    expect(cfg.seedUrl).toBe('https://www.example.com');
  });

  it('accepts http:// scheme', () => {
    const cfg = CrawlConfig.builder('http://example.com').build();
    expect(cfg.seedUrl).toBe('http://example.com');
  });

  it('trims leading/trailing whitespace from seedUrl', () => {
    const cfg = CrawlConfig.builder('  https://example.com  ').build();
    expect(cfg.seedUrl).toBe('https://example.com');
  });

  it('exposes default values', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.maxDepth).toBe(Infinity);
    expect(cfg.workers).toBe(4);
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.requestDelayMs).toBe(500);
    expect(cfg.respectRobotsTxt).toBe(true);
    expect(cfg.seedFromSitemap).toBe(true);
    expect(cfg.detectDuplicates).toBe(true);
    expect(cfg.ssrfPolicy).toBe(SsrfPolicy.BLOCK_PRIVATE);
  });

  it('is frozen (immutable)', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.includePatterns)).toBe(true);
    expect(Object.isFrozen(cfg.excludePatterns)).toBe(true);
  });
});

describe('CrawlConfig.Builder — validation errors', () => {

  it('throws on blank seedUrl', () => {
    expect(() => CrawlConfig.builder('')).toThrow('seedUrl must not be blank');
  });

  it('throws when seedUrl has no http/https scheme', () => {
    expect(() => CrawlConfig.builder('ftp://example.com'))
      .toThrow('seedUrl must begin with');
  });

  it('throws when workers < 1', () => {
    expect(() => CrawlConfig.builder(seed).workers(0).build())
      .toThrow('workers must be >= 1');
  });

  it('throws when jitterPct > 100', () => {
    expect(() => CrawlConfig.builder(seed).jitterPct(101).build())
      .toThrow('jitterPct must be 0–100');
  });

  it('throws when jitterPct < 0', () => {
    expect(() => CrawlConfig.builder(seed).jitterPct(-1).build())
      .toThrow('jitterPct must be 0–100');
  });

  it('throws when maxRetries < 0', () => {
    expect(() => CrawlConfig.builder(seed).maxRetries(-1).build())
      .toThrow('maxRetries must be >= 0');
  });

  it('throws when maxBodyBytes <= 0', () => {
    expect(() => CrawlConfig.builder(seed).maxBodyBytes(0).build())
      .toThrow('maxBodyBytes must be > 0');
  });

  it('throws when a pattern appears in both include and exclude lists', () => {
    expect(() =>
      CrawlConfig.builder(seed).includePattern('/blog/').excludePattern('/blog/').build()
    ).toThrow('Pattern appears in both include and exclude lists: "/blog/"');
  });
});

describe('CrawlConfig.Builder — fluent setters', () => {

  it('sets maxDepth', () => {
    expect(CrawlConfig.builder(seed).maxDepth(3).build().maxDepth).toBe(3);
  });

  it('accumulates multiple includePatterns', () => {
    const cfg = CrawlConfig.builder(seed)
      .includePattern('/blog/')
      .includePattern('/news/')
      .build();
    expect(cfg.includePatterns).toEqual(['/blog/', '/news/']);
  });

  it('accumulates multiple excludePatterns', () => {
    const cfg = CrawlConfig.builder(seed)
      .excludePattern('/admin/')
      .excludePattern('/login/')
      .build();
    expect(cfg.excludePatterns).toEqual(['/admin/', '/login/']);
  });

  it('returns `this` for chaining on every setter', () => {
    const b = CrawlConfig.builder(seed);
    expect(b.workers(2)).toBe(b);
    expect(b.maxDepth(5)).toBe(b);
    expect(b.requestDelayMs(0)).toBe(b);
  });
});

describe('CrawlConfig.isInternalLink', () => {

  it('accepts URL on exact domain', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInternalLink('https://example.com/page')).toBe(true);
  });

  it('accepts URL with www. prefix (normalised)', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInternalLink('https://www.example.com/page')).toBe(true);
  });

  it('rejects a different domain', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInternalLink('https://other.com/page')).toBe(false);
  });

  it('rejects a subdomain when crawlSubdomains is false', () => {
    const cfg = CrawlConfig.builder(seed).crawlSubdomains(false).build();
    expect(cfg.isInternalLink('https://blog.example.com/post')).toBe(false);
  });

  it('accepts a subdomain when crawlSubdomains is true', () => {
    const cfg = CrawlConfig.builder(seed).crawlSubdomains(true).build();
    expect(cfg.isInternalLink('https://blog.example.com/post')).toBe(true);
  });

  it('returns false for a malformed URL', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInternalLink('not a url')).toBe(false);
  });
});

describe('CrawlConfig.isInScope', () => {

  it('returns false for empty string', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInScope('')).toBe(false);
  });

  it('passes a plain internal URL with no patterns', () => {
    const cfg = CrawlConfig.builder(seed).build();
    expect(cfg.isInScope('https://example.com/about')).toBe(true);
  });

  it('respects excludePattern — blocks matching URL', () => {
    const cfg = CrawlConfig.builder(seed).excludePattern('/admin/').build();
    expect(cfg.isInScope('https://example.com/admin/users')).toBe(false);
    expect(cfg.isInScope('https://example.com/about')).toBe(true);
  });

  it('respects includePattern — requires match', () => {
    const cfg = CrawlConfig.builder(seed).includePattern('/blog/').build();
    expect(cfg.isInScope('https://example.com/blog/post-1')).toBe(true);
    expect(cfg.isInScope('https://example.com/about')).toBe(false);
  });

  it('excludePattern takes priority over includePattern', () => {
    const cfg = CrawlConfig.builder(seed)
      .includePattern('/blog/')
      .excludePattern('/blog/draft/')
      .build();
    expect(cfg.isInScope('https://example.com/blog/published')).toBe(true);
    expect(cfg.isInScope('https://example.com/blog/draft/post')).toBe(false);
  });

  it('rejects external URL even if it matches includePattern', () => {
    const cfg = CrawlConfig.builder(seed).includePattern('/blog/').build();
    expect(cfg.isInScope('https://other.com/blog/post')).toBe(false);
  });
});
