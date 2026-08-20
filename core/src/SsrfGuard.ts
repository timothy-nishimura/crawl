import { lookup }          from 'node:dns';
import { buildConnector }  from 'undici';
import { SsrfPolicy }      from './SsrfPolicy.js';

/**
 * SSRF protection guard.
 *
 * Two entry points:
 *
 * - `SsrfGuard.check(hostname, policy)` — async, used in tests and direct
 *   callers.  Resolves the hostname via the OS resolver (`dns.lookup`) so
 *   that non-standard IP literals such as `127.1` or `0x7f000001` are
 *   normalised before the private-range test.  On DNS failure the request is
 *   **blocked** (fail-closed), not silently allowed.
 *
 * - `SsrfGuard.makeConnector(policy)` — returns a custom `undici`
 *   `buildConnector.connector` that performs DNS resolution and the IP check
 *   inside the TCP connect callback, then passes the **resolved IP** (not the
 *   original hostname) to the underlying socket.  This eliminates the
 *   Time-of-Check-to-Time-of-Use (TOCTOU) window that exists when the check
 *   and the connect are separate steps, and defeats DNS-rebinding attacks.
 */
export class SsrfGuard {
  /**
   * Async hostname check.  Resolves via the OS resolver so that all IP
   * representations (`127.1`, `0x7f000001`, `::1`, IPv4-mapped IPv6, …) are
   * normalised.  Throws `SsrfError` if blocked.
   *
   * **Fail-closed**: DNS resolution failure throws, it does NOT silently allow
   * the request through.
   */
  static async check(hostname: string, policy: SsrfPolicy): Promise<void> {
    if (policy === SsrfPolicy.ALLOW_ALL) return;

    const ip = await resolveHostname(hostname);
    SsrfGuard.checkIp(ip, policy, hostname);
  }

  /**
   * Synchronous IP check against the private-range list.
   * Call this when you have already resolved the IP (e.g. inside a connector).
   * Throws `SsrfError` if `ip` falls in a blocked range.
   *
   * @param ip       Already-resolved dotted-decimal IPv4 or colon-hex IPv6.
   * @param policy   The enforcement policy.
   * @param hostname Original hostname, used only for the error message.
   */
  static checkIp(
    ip:       string,
    policy:   SsrfPolicy,
    hostname  = ip,
  ): void {
    if (policy === SsrfPolicy.ALLOW_ALL) return;
    if (isPrivateAddress(ip)) {
      throw new SsrfError(
        `SSRF blocked: ${hostname} resolves to private address ${ip}`,
        hostname,
        ip,
      );
    }
  }

  /**
   * Returns a custom `undici` connector that:
   * 1. Resolves the hostname via the OS resolver (same as `check`, handles
   *    alt-IP formats).
   * 2. Checks the resolved IP immediately (`checkIp`).
   * 3. Passes the **resolved IP** to the underlying socket, so `undici` never
   *    performs a second DNS lookup — eliminating the TOCTOU window.
   *
   * For TLS connections the original hostname is preserved as `servername`
   * (SNI) so certificate validation works correctly.
   *
   * @example
   * ```ts
   * const agent = new Agent({ connect: SsrfGuard.makeConnector(policy), ... });
   * ```
   */
  static makeConnector(policy: SsrfPolicy): import('undici').buildConnector.connector {
    const defaultConnector = buildConnector({});

    return (opts, cb) => {
      if (policy === SsrfPolicy.ALLOW_ALL) {
        defaultConnector(opts, cb);
        return;
      }

      const { hostname } = opts;

      lookup(hostname, (err, address) => {
        if (err) {
          cb(
            new SsrfError(
              `SSRF blocked: DNS resolution failed for ${hostname}: ${err.message}`,
              hostname,
              '',
            ),
            null,
          );
          return;
        }

        try {
          SsrfGuard.checkIp(address, policy, hostname);
        } catch (ssrfErr) {
          cb(ssrfErr instanceof Error ? ssrfErr : new Error(String(ssrfErr)), null);
          return;
        }

        // Connect to the resolved IP directly — no second DNS lookup.
        // Preserve the original hostname as TLS SNI servername.
        defaultConnector(
          {
            ...opts,
            hostname: address,
            servername: opts.servername ?? hostname,
          },
          cb,
        );
      });
    };
  }
}

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly hostname: string,
    readonly resolvedIp: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolves `hostname` to a canonical IP string via the OS resolver.
 * Fails-closed: throws on DNS error.
 */
function resolveHostname(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, (err, address) => {
      if (err) reject(new Error(`DNS lookup failed for ${hostname}: ${err.message}`));
      else     resolve(address);
    });
  });
}

/**
 * Returns true if `ip` is a private, loopback, link-local, or reserved address.
 * Input must already be a normalised dotted-decimal IPv4 or colon-hex IPv6
 * string (as returned by `dns.lookup` or `net.isIP`).
 */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const rest = lower.slice(7);
      if (rest.includes('.')) {
        return isPrivateAddress(rest);
      }
      const hexParts = rest.split(':');
      if (hexParts.length === 2 && hexParts[0] && hexParts[1]) {
        const p1 = parseInt(hexParts[0], 16);
        const p2 = parseInt(hexParts[1], 16);
        if (!isNaN(p1) && !isNaN(p2)) {
          const v4 = `${(p1 >> 8) & 0xff}.${p1 & 0xff}.${(p2 >> 8) & 0xff}.${p2 & 0xff}`;
          return isPrivateAddress(v4);
        }
      }
    }
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('ff') ||
      lower.startsWith('2002:') ||
      lower.startsWith('2001:0') ||
      lower.startsWith('2001::')
    );
  }

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [a, b, c] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
