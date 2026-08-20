import { resolve, join, normalize, relative } from 'node:path';
import { mkdirSync }                    from 'node:fs';

/**
 * Security — shared security utilities for the @crawl/engine.
 */
export class Security {
  /**
   * Validates and normalizes a user-provided path to ensure it stays within
   * a specific sandbox directory.
   *
   * Rejects paths that:
   *  - Are absolute (unless they resolve inside the sandbox)
   *  - Contain path traversal (..) that escapes the sandbox
   *  - Target sensitive system directories
   *
   * @param userPath - The path provided by the user (relative or absolute).
   * @param sandboxDir - The root directory allowed for file operations (default: scratch/).
   * @returns The absolute, sanitized path.
   * @throws Error if the path is unsafe.
   */
  static sandboxPath(userPath: string, sandboxDir?: string | string[]): string {
    const defaultRoots = [
      process.env['SCRATCH_DIR'] || './scratch',
      process.env['MANIFESTS_DIR'] || './manifests',
      process.env['DATA_DIR'] || './data',
    ];

    const targetRoots = Array.isArray(sandboxDir)
      ? sandboxDir
      : sandboxDir
      ? [sandboxDir]
      : defaultRoots;

    const resolvedRoots = targetRoots.map(r => resolve(r));

    for (const root of resolvedRoots) {
      try {
        mkdirSync(root, { recursive: true });
      } catch {
        // Ignore existing directory or permission error
      }
    }

    const candidate = resolve(resolvedRoots[0] ?? '.', userPath);

    for (const root of resolvedRoots) {
      const rel = relative(root, candidate);
      const isInside = (rel === '' || (!rel.startsWith('..') && !normalize(rel).startsWith('..')));
      if (isInside) {
        return candidate;
      }
    }

    throw new Error(`Security Violation: Path traversal detected or path outside sandbox: ${userPath}`);
  }

  /**
   * Strictly validates a URL to ensure it is http or https.
   * Rejects file://, ftp://, and local network IPs if SsrfGuard is active.
   *
   * @param url - The URL to check.
   * @throws Error if the URL is unsafe.
   */
  static validateUrl(url: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Security Violation: Only http and https protocols are allowed. Got: ${u.protocol}`);
    }
  }

}
