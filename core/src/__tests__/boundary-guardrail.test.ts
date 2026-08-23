import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Locate monorepo root regardless of whether jest runs from repo root or core workspace
const currentDir = process.cwd();
const ROOT_DIR = existsSync(join(currentDir, 'core/package.json'))
  ? currentDir
  : resolve(currentDir, '..');

const SCRIPT_PATH = resolve(ROOT_DIR, 'scripts/check-core-boundaries.mjs');
const PKG_PATH = resolve(ROOT_DIR, 'core/package.json');
const SEC_PATH = resolve(ROOT_DIR, 'core/src/Security.ts');

describe('Core Boundary Guardrail Tests', () => {
  test('Positive Case: Passes on current pure core codebase', () => {
    const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8', cwd: ROOT_DIR });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Core boundary check PASSED');
  });

  test('Negative Case 1: Catches unauthorized file in core/src/', () => {
    const dummyFile = resolve(ROOT_DIR, 'core/src/UnauthorizedProbe.ts');
    try {
      writeFileSync(dummyFile, 'export const leak = 1;');
      const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8', cwd: ROOT_DIR });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Unauthorized file found in core/src/: "UnauthorizedProbe.ts"');
    } finally {
      try { unlinkSync(dummyFile); } catch { /* ignore */ }
    }
  });

  test('Negative Case 2: Catches dependency inflation in core/package.json', () => {
    const originalPkg = readFileSync(PKG_PATH, 'utf-8');
    try {
      const tamperedPkg = JSON.parse(originalPkg);
      tamperedPkg.dependencies['playwright'] = '^1.60.0';
      writeFileSync(PKG_PATH, JSON.stringify(tamperedPkg, null, 2));

      const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8', cwd: ROOT_DIR });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Unauthorized dependency in core/package.json: "playwright"');
    } finally {
      writeFileSync(PKG_PATH, originalPkg);
    }
  });

  test('Negative Case 3: Catches domain heuristics in core code', () => {
    const originalSec = readFileSync(SEC_PATH, 'utf-8');
    try {
      writeFileSync(SEC_PATH, originalSec + '\n// const JS_GATED_DOMAINS = ["twitter.com"];');
      const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8', cwd: ROOT_DIR });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Forbidden pattern "JS_GATED_DOMAINS" found in core/src/Security.ts');
    } finally {
      writeFileSync(SEC_PATH, originalSec);
    }
  });

  test('Negative Case 4: Catches downstream module imports in core code', () => {
    const originalSec = readFileSync(SEC_PATH, 'utf-8');
    try {
      writeFileSync(SEC_PATH, originalSec + '\nimport { foo } from \'@crawl/extractors\';');
      const res = spawnSync('node', [SCRIPT_PATH], { encoding: 'utf-8', cwd: ROOT_DIR });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Forbidden pattern "from \'@crawl/" found in core/src/Security.ts');
    } finally {
      writeFileSync(SEC_PATH, originalSec);
    }
  });
});
