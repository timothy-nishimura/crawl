import { describe, it, expect } from '@jest/globals';
import { load } from 'cheerio';
import { HeadingExtractor } from '../HeadingExtractor.js';
import { LinkExtractor } from '../LinkExtractor.js';
import { MetaExtractor } from '../MetaExtractor.js';
import { SeoExtractor } from '../SeoExtractor.js';
import { ParsedPage, FetchResult } from '@crawl/engine';

describe('@crawl/extractors', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
        <meta name="description" content="Test description">
        <meta property="og:title" content="OG Test Title">
      </head>
      <body>
        <h1>Main Title</h1>
        <h2>Subheading</h2>
        <a href="/about">About Us</a>
        <a href="https://external.com/page">External</a>
      </body>
    </html>
  `;

  const fetchResult = FetchResult.builder('https://example.com/')
    .statusCode(200)
    .body(new TextEncoder().encode(html))
    .contentType('text/html')
    .build();

  const doc = load(html);
  const parsedPage = ParsedPage.create(fetchResult, doc, 0);

  it('extracts headings correctly', () => {
    const extractor = new HeadingExtractor();
    const result = extractor.extract(parsedPage);
    expect(result).not.toBeNull();
    expect(result?.counts.h1).toBe(1);
    expect(result?.counts.h2).toBe(1);
    expect(result?.headings[0]?.text).toBe('Main Title');
  });

  it('extracts links correctly', () => {
    const extractor = new LinkExtractor();
    const result = extractor.extract(parsedPage);
    expect(result).not.toBeNull();
    expect(result?.internal.map(l => l.href)).toContain('https://example.com/about');
    expect(result?.external.map(l => l.href)).toContain('https://external.com/page');
  });

  it('extracts metadata correctly', () => {
    const extractor = new MetaExtractor();
    const result = extractor.extract(parsedPage);
    expect(result).not.toBeNull();
    expect(result?.openGraph?.title).toBe('OG Test Title');
  });

  it('runs composite SeoExtractor', () => {
    const extractor = new SeoExtractor();
    const result = extractor.extract(parsedPage);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Test Page');
    expect(result?.h1).toBe('Main Title');
  });
});
