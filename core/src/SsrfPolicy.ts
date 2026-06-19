/**
 * Controls whether private/reserved IP ranges are blocked before each fetch.
 *
 * - `BLOCK_PRIVATE` — resolves the hostname and rejects requests that would
 *   reach loopback, link-local, private (RFC 1918/4193), or reserved addresses.
 *   Use this for all multi-tenant / server-side deployments.
 *
 * - `ALLOW_ALL` — no SSRF checking. For intranet crawling where private
 *   addresses are intentional targets.
 */
export enum SsrfPolicy {
  BLOCK_PRIVATE = 'BLOCK_PRIVATE',
  ALLOW_ALL     = 'ALLOW_ALL',
}
