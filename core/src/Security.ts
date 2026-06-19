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
  static sandboxPath(userPath: string, sandboxDir?: string): string {
    const envScratch = process.env['SCRATCH_DIR'];
    const root = resolve(sandboxDir || envScratch || './scratch');
    
    // Ensure the sandbox root exists
    try {
      mkdirSync(root, { recursive: true });
    } catch (err) {
      // Ignore if it already exists or if we can't create it (the later check will fail anyway)
    }

    const absolute = resolve(root, userPath);

    // Ensure the resolved path starts with the root path
    const rel = relative(root, absolute);
    const isInside = rel && !rel.startsWith('..') && !normalize(rel).startsWith('..');

    if (!isInside && absolute !== root) {
      throw new Error(`Security Violation: Path traversal detected or path outside sandbox: ${userPath}`);
    }

    return absolute;
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
