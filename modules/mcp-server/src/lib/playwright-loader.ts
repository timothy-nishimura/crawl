import type { FetchBackend } from '@crawl/engine';

/**
 * Lazily loads @crawl/playwright-backend, mirroring how TlsFetchBackend
 * lazy-loads got-scraping (modules/tls-backend/src/TlsFetchBackend.ts).
 * Keeping this as a dynamic import — never a static one — is what lets the
 * operator bundle mark @crawl/playwright-backend (and Chromium) external and
 * drop it from the graph entirely. renderJs stays broken with a clear error
 * in that build rather than pulling in a browser it doesn't ship.
 */
type PlaywrightModule = typeof import('@crawl/playwright-backend');

let _mod: PlaywrightModule | null = null;

async function loadModule(): Promise<PlaywrightModule> {
  if (_mod) return _mod;
  try {
    _mod = await import('@crawl/playwright-backend');
    return _mod;
  } catch (err) {
    throw new Error(
      'Playwright backend unavailable — renderJs requires @crawl/playwright-backend ' +
      'and its browser binaries to be installed. Run "npx playwright install chromium". ' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function createPlaywrightBackend(
  options?: Parameters<PlaywrightModule['PlaywrightFetchBackend']['create']>[0],
): Promise<FetchBackend> {
  const mod = await loadModule();
  return mod.PlaywrightFetchBackend.create(options);
}
