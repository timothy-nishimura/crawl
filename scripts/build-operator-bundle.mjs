#!/usr/bin/env node
/**
 * Builds the operator plugin bundle: a single ESM file carrying the curated
 * 10-tool MCP server (modules/mcp-server/src/operator-stdio.ts), plus a
 * vendored got-scraping — the one runtime dependency that can't be inlined
 * into the bundle. See the two hazard sections below for why.
 *
 * Usage:   node scripts/build-operator-bundle.mjs
 * Prerequisite: npm run build --workspaces
 *
 * This bundles tsc's *output* (modules/mcp-server/dist/), not the
 * TypeScript source — tsc stays the correctness gate, esbuild only
 * concatenates and tree-shakes already-typechecked JS.
 */
import { build } from 'esbuild';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(ROOT, 'modules/mcp-server/dist/operator-stdio.js');
const OUT_DIR = resolve(ROOT, 'dist-operator');
const OUT_FILE = resolve(OUT_DIR, 'index.mjs');

// ── Preflight ──────────────────────────────────────────────────────────────

if (!existsSync(ENTRY)) {
  console.error(`[build-operator-bundle] ${ENTRY} does not exist.`);
  console.error('Run "npm run build --workspaces" first — this script bundles tsc\'s output, it does not compile TypeScript itself.');
  process.exit(1);
}

// ── Hazard 1: jsdom's unguarded top-level require.resolve("./xhr-sync-worker.js") ──
//
// jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js resolves its sync-XHR
// worker script at import time, unconditionally:
//   const syncWorkerFile = require.resolve ? require.resolve("./xhr-sync-worker.js") : null;
// After bundling, the code has moved and that file no longer exists at any
// resolvable path relative to the bundle, so this throws MODULE_NOT_FOUND
// the instant jsdom is imported — confirmed by running an unpatched trial
// bundle. Sync XHR is unreachable in this codebase regardless: every JSDOM
// instance fetchPage.ts constructs uses runScripts: 'outside-only'. Rewrite
// the expression to `null` so the module loads; throw at build time if the
// exact string is gone, so a jsdom version bump fails the build loudly
// instead of silently shipping a broken bundle.
const JSDOM_SYNC_XHR_NEEDLE = 'require.resolve ? require.resolve("./xhr-sync-worker.js") : null';

const jsdomSyncXhrPatch = {
  name: 'jsdom-sync-xhr-patch',
  setup(esbuildBuild) {
    esbuildBuild.onLoad({ filter: /XMLHttpRequest-impl\.js$/ }, (args) => {
      const contents = readFileSync(args.path, 'utf8');
      if (!contents.includes(JSDOM_SYNC_XHR_NEEDLE)) {
        throw new Error(
          `[jsdom-sync-xhr-patch] Expected string not found in ${args.path}. ` +
          'jsdom\'s internals changed — update JSDOM_SYNC_XHR_NEEDLE in this script before rebuilding.',
        );
      }
      return { contents: contents.replace(JSDOM_SYNC_XHR_NEEDLE, 'null'), loader: 'js' };
    });
  },
};

// ── Hazard 2: got-scraping is ESM-only and reads data by __dirname ──────────
//
// got-scraping's package.json publishes only an "import" export condition
// (no "require"), and its header-generator dependency reads two .zip files
// via `${__dirname}/data_files/...json|zip` at runtime. No bundler can
// inline that and keep it working — bundling moves the code away from its
// data files, and __dirname inside bundled code resolves to the bundle's
// own directory, not header-generator's. Keep it external and ship a real
// node_modules next to the bundle instead (vendorGotScraping, below).
//
// @crawl/playwright-backend is external too: it's reached only through
// playwright-loader.js's `await import('@crawl/playwright-backend')`, and
// esbuild bundles a dynamic import of a resolvable package by default
// unless told not to (confirmed — an unpatched trial bundle pulled in the
// whole of playwright-core, including native fsevents/.node files esbuild
// can't even load). The operator build ships no browser at all: at runtime
// the loader's try/catch degrades to its own clean error message.
const EXTERNAL = [
  'got-scraping',
  '@crawl/playwright-backend',
  'canvas',          // jsdom peer dep, optional, try/catch-wrapped
  'bufferutil',       // ws optional native accelerator, try/catch-wrapped
  'utf-8-validate',   // ws optional native accelerator, try/catch-wrapped
];

// Several CJS dependencies bundled into this ESM output call require() for
// things esbuild can't statically resolve inside their own module scope
// (e.g. safer-buffer's `require('buffer')`, several layers deep in
// cheerio's own dependency chain) — an ES module has no ambient `require`.
// A handful of bundled CJS files also reference __filename/__dirname
// directly, which don't exist in ESM either. Confirmed via trial bundle:
// without this banner, the process throws "Dynamic require of ... is not
// supported" on startup, before ever reaching our own code.
const BANNER = [
  "import { createRequire as __crawl_createRequire } from 'node:module';",
  "import { fileURLToPath as __crawl_fileURLToPath } from 'node:url';",
  "import { dirname as __crawl_dirname } from 'node:path';",
  'const require = __crawl_createRequire(import.meta.url);',
  'const __filename = __crawl_fileURLToPath(import.meta.url);',
  'const __dirname = __crawl_dirname(__filename);',
].join('\n');

async function bundle() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: OUT_FILE,
    external: EXTERNAL,
    banner: { js: BANNER },
    plugins: [jsdomSyncXhrPatch],
    sourcemap: true,
    logLevel: 'info',
  });

  const bytes = readFileSync(OUT_FILE).length;
  console.log(`[build-operator-bundle] wrote ${OUT_FILE} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

// ── Vendor got-scraping + its full production dependency closure ───────────
//
// npm already resolves a package's real transitive closure correctly,
// including nested node_modules where a transitive dep needs a conflicting
// version — reimplementing that by hand would just be a worse, less-tested
// version of npm install. Node resolves node_modules by walking upward from
// the importing file, so a node_modules directory sitting next to index.mjs
// is exactly what the external `got-scraping` import needs at runtime.
function vendorGotScraping() {
  const installedVersion = JSON.parse(
    readFileSync(resolve(ROOT, 'node_modules/got-scraping/package.json'), 'utf8'),
  ).version;

  writeFileSync(
    resolve(OUT_DIR, 'package.json'),
    JSON.stringify({
      name: 'crawl-operator-server',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        'got-scraping': installedVersion,
      },
    }, null, 2) + '\n',
  );

  console.log(`[build-operator-bundle] vendoring got-scraping@${installedVersion} into ${OUT_DIR}/node_modules ...`);
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: OUT_DIR,
    stdio: 'inherit',
  });
}

await bundle();
vendorGotScraping();
console.log('[build-operator-bundle] done.');
