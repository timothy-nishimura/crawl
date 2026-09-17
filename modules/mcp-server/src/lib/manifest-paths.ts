import { resolve, isAbsolute } from 'node:path';

/**
 * Resolves a bare manifest filename (no path separators, e.g.
 * "example.com-2026-01-01T00-00-00.json") against MANIFESTS_DIR.
 *
 * Security.sandboxPath() anchors a bare name against its first default root
 * (SCRATCH_DIR) — that ordering is load-bearing for fetchPage.ts's
 * preloadedHtmlFile, so it isn't changed. Without this helper, a bare
 * manifest name saved to MANIFESTS_DIR wouldn't be found again by a bare
 * name passed to search_manifest/summarize_manifest/etc., since they'd
 * resolve it against SCRATCH_DIR instead.
 *
 * Absolute paths and explicitly relative paths ('./x', '../x') are left
 * untouched — Security.sandboxPath still enforces they land inside an
 * allowed root.
 */
export function resolveManifestName(name: string): string {
  if (isAbsolute(name) || name.startsWith('./') || name.startsWith('../')) {
    return name;
  }
  const manifestsDir = process.env['MANIFESTS_DIR'] || './manifests';
  return resolve(manifestsDir, name);
}

/**
 * Builds an auto-generated manifest filename from a seed URL, resolved
 * against MANIFESTS_DIR: "<host>-<timestamp>.json". Timestamp uses
 * filesystem-safe characters (no colons).
 */
export function autoManifestName(seedUrl: string): string {
  const host = (() => {
    try {
      return new URL(seedUrl).hostname;
    } catch {
      return 'manifest';
    }
  })();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return resolveManifestName(`${host}-${timestamp}.json`);
}
