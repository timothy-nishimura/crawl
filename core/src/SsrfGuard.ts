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
  // IPv6
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    // IPv4-mapped: ::ffff:192.168.x.x — check the v4 part
    if (lower.startsWith('::ffff:')) {
      return isPrivateAddress(lower.slice(7));
    }
    return (
      lower === '::1'           ||   // loopback
      lower === '::'            ||   // unspecified
      lower.startsWith('fc')   ||   // ULA fc00::/7
      lower.startsWith('fd')   ||   // ULA fd00::/8
      lower.startsWith('fe80')      // link-local fe80::/10
    );
  }

  // IPv4 — dotted-decimal only at this point (dns.lookup output)
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    // Malformed — treat as blocked to be safe
    return true;
  }

  const [a, b, c] = parts as [number, number, number, number];

  return (
    a === 0                                    ||  // 0.0.0.0/8 reserved
    a === 10                                   ||  // 10.0.0.0/8 RFC 1918
    a === 127                                  ||  // 127.0.0.0/8 loopback
    (a === 100 && b >= 64  && b <= 127)        ||  // 100.64.0.0/10 shared
    (a === 169 && b === 254)                   ||  // 169.254.0.0/16 link-local
    (a === 172 && b >= 16  && b <= 31)         ||  // 172.16.0.0/12 RFC 1918
    (a === 192 && b === 0  && c === 2)         ||  // TEST-NET-1
    (a === 192 && b === 168)                   ||  // 192.168.0.0/16 RFC 1918
    (a === 198 && b === 51 && c === 100)       ||  // TEST-NET-2
    (a === 203 && b === 0  && c === 113)       ||  // TEST-NET-3
    a >= 240                                       // 240.0.0.0/4 reserved
  );
}
