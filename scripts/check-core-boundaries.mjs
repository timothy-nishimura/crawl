#!/usr/bin/env node

/**
 * Core Boundary Checker (Automated Guardrail)
 *
 * Enforces the architectural purity of @crawl/engine:
 * 1. Dependency Whitelist in core/package.json
 * 2. Source File Whitelist in core/src/
 * 3. Zero Downstream / Module Imports in core/src/
 * 4. Zero Domain Heuristics in core/src/
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve monorepo root
const ROOT_DIR = existsSync(join(__dirname, '../core'))
  ? resolve(__dirname, '..')
  : process.cwd();

const CORE_DIR = resolve(ROOT_DIR, 'core');
const CORE_SRC = resolve(CORE_DIR, 'src');

const ALLOWED_DEPENDENCIES = new Set([
  'cheerio',
  'robots-parser',
  'undici',
]);

const ALLOWED_SRC_FILES = new Set([
  'BodyDeduplicator.ts',
  'CookieJar.ts',
  'CrawlConfig.ts',
  'CrawlEngine.ts',
  'CrawlObserver.ts',
  'CrawlSummary.ts',
  'Extractor.ts',
  'FetchBackend.ts',
  'FetchRequest.ts',
  'FetchResult.ts',
  'Frontier.ts',
  'HttpClientBackend.ts',
  'InMemoryFrontier.ts',
  'PageSnapshot.ts',
  'ParsedPage.ts',
  'RateLimiter.ts',
  'RobotsCache.ts',
  'Security.ts',
  'SsrfGuard.ts',
  'SsrfPolicy.ts',
  'UrlNormalizer.ts',
  'index.ts',
  '__tests__',
]);

const FORBIDDEN_TOKENS_IN_CORE = [
  'SEARCH_ENGINES',
  'JS_GATED_DOMAINS',
  'real-estate-recipes.json',
  "from '@crawl/",
  'from "../modules/',
  'playwright',
];

let failures = 0;

console.log('🛡️  [Core Boundary Check] Auditing @crawl/engine...');

// 1. Audit core/package.json dependencies
try {
  const pkgRaw = readFileSync(join(CORE_DIR, 'package.json'), 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  const deps = Object.keys(pkg.dependencies || {});

  for (const dep of deps) {
    if (!ALLOWED_DEPENDENCIES.has(dep)) {
      console.error(`❌ [Dependency Violation] Unauthorized dependency in core/package.json: "${dep}"`);
      failures++;
    }
  }

  const unlisted = [...ALLOWED_DEPENDENCIES].filter(d => !deps.includes(d));
  if (unlisted.length === 0 && deps.length === ALLOWED_DEPENDENCIES.size) {
    console.log('✅ Dependencies: Whitelist verified (cheerio, robots-parser, undici only).');
  }
} catch (err) {
  console.error('❌ Failed to read core/package.json:', err.message);
  failures++;
}

// 2. Audit files in core/src
try {
  const files = readdirSync(CORE_SRC).filter(f => !f.startsWith('.'));
  for (const file of files) {
    if (!ALLOWED_SRC_FILES.has(file)) {
      console.error(`❌ [File Leak] Unauthorized file found in core/src/: "${file}"`);
      failures++;
    }
  }
  console.log(`✅ File Inventory: All ${files.length} items in core/src/ match the authorized whitelist.`);
} catch (err) {
  console.error('❌ Failed to list core/src:', err.message);
  failures++;
}

// 3. Audit forbidden tokens / domain heuristics in core/src
try {
  const files = readdirSync(CORE_SRC).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const content = readFileSync(join(CORE_SRC, file), 'utf-8');
    for (const token of FORBIDDEN_TOKENS_IN_CORE) {
      if (content.includes(token)) {
        console.error(`❌ [Heuristic/Module Leak] Forbidden pattern "${token}" found in core/src/${file}`);
        failures++;
      }
    }
  }
  if (failures === 0) {
    console.log('✅ Purity: Zero domain heuristics or module imports found in core source code.');
  }
} catch (err) {
  console.error('❌ Failed to scan file contents:', err.message);
  failures++;
}

if (failures > 0) {
  console.error(`\n🚨 Core boundary check FAILED with ${failures} violation(s).\n`);
  process.exit(1);
} else {
  console.log('\n🎉 Core boundary check PASSED. @crawl/engine is 100% pure.\n');
  process.exit(0);
}
