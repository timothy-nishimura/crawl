import { describe, it, expect } from '@jest/globals';
import { SsrfGuard, SsrfError, isPrivateAddress } from '../SsrfGuard.js';
import { SsrfPolicy }                              from '../SsrfPolicy.js';

// ── isPrivateAddress unit tests ───────────────────────────────────────────────

describe('isPrivateAddress', () => {

  // ── IPv4 loopback ────────────────────────────────────────────────────────
  it('blocks 127.0.0.1 (loopback)', () => expect(isPrivateAddress('127.0.0.1')).toBe(true));
  it('blocks 127.255.255.255 (loopback /8)', () => expect(isPrivateAddress('127.255.255.255')).toBe(true));

  // ── RFC 1918 ─────────────────────────────────────────────────────────────
  it('blocks 10.0.0.1 (RFC 1918 /8)',      () => expect(isPrivateAddress('10.0.0.1')).toBe(true));
  it('blocks 10.255.255.255',               () => expect(isPrivateAddress('10.255.255.255')).toBe(true));
  it('blocks 172.16.0.1 (RFC 1918 /12)',   () => expect(isPrivateAddress('172.16.0.1')).toBe(true));
  it('blocks 172.31.255.255',               () => expect(isPrivateAddress('172.31.255.255')).toBe(true));
  it('allows 172.15.255.255 (just outside)', () => expect(isPrivateAddress('172.15.255.255')).toBe(false));
  it('allows 172.32.0.1 (just outside)',    () => expect(isPrivateAddress('172.32.0.1')).toBe(false));
  it('blocks 192.168.0.1 (RFC 1918 /16)',  () => expect(isPrivateAddress('192.168.0.1')).toBe(true));
  it('blocks 192.168.255.255',              () => expect(isPrivateAddress('192.168.255.255')).toBe(true));

  // ── Link-local ────────────────────────────────────────────────────────────
  it('blocks 169.254.0.1 (link-local)',     () => expect(isPrivateAddress('169.254.0.1')).toBe(true));
  it('blocks 169.254.169.254 (AWS IMDS)',   () => expect(isPrivateAddress('169.254.169.254')).toBe(true));

  // ── Shared address space (CGNAT) ─────────────────────────────────────────
  it('blocks 100.64.0.1 (CGNAT /10)',       () => expect(isPrivateAddress('100.64.0.1')).toBe(true));
  it('blocks 100.127.255.255',              () => expect(isPrivateAddress('100.127.255.255')).toBe(true));
  it('allows 100.63.255.255 (just outside)', () => expect(isPrivateAddress('100.63.255.255')).toBe(false));

  // ── Reserved / documentation ─────────────────────────────────────────────
  it('blocks 0.0.0.0',                      () => expect(isPrivateAddress('0.0.0.0')).toBe(true));
  it('blocks 0.1.2.3 (0.0.0.0/8)',          () => expect(isPrivateAddress('0.1.2.3')).toBe(true));
  it('blocks 240.0.0.1 (reserved /4)',       () => expect(isPrivateAddress('240.0.0.1')).toBe(true));
  it('blocks 255.255.255.255',               () => expect(isPrivateAddress('255.255.255.255')).toBe(true));
  it('blocks 192.0.2.1 (TEST-NET-1)',        () => expect(isPrivateAddress('192.0.2.1')).toBe(true));
  it('blocks 198.51.100.1 (TEST-NET-2)',     () => expect(isPrivateAddress('198.51.100.1')).toBe(true));
  it('blocks 203.0.113.1 (TEST-NET-3)',      () => expect(isPrivateAddress('203.0.113.1')).toBe(true));

  // ── Public IPs (must NOT be blocked) ─────────────────────────────────────
  it('allows 1.1.1.1 (Cloudflare DNS)',      () => expect(isPrivateAddress('1.1.1.1')).toBe(false));
  it('allows 8.8.8.8 (Google DNS)',          () => expect(isPrivateAddress('8.8.8.8')).toBe(false));
  it('allows 93.184.216.34 (example.com)',   () => expect(isPrivateAddress('93.184.216.34')).toBe(false));
  it('allows 198.51.99.1 (just before TEST-NET-2)', () => expect(isPrivateAddress('198.51.99.1')).toBe(false));

  // ── IPv6 ─────────────────────────────────────────────────────────────────
  it('blocks ::1 (IPv6 loopback)',           () => expect(isPrivateAddress('::1')).toBe(true));
  it('blocks :: (IPv6 unspecified)',         () => expect(isPrivateAddress('::')).toBe(true));
  it('blocks fc00::1 (ULA fc00::/7)',        () => expect(isPrivateAddress('fc00::1')).toBe(true));
  it('blocks fd12:3456:789a::1 (ULA)',       () => expect(isPrivateAddress('fd12:3456:789a::1')).toBe(true));
  it('blocks fe80::1 (link-local)',          () => expect(isPrivateAddress('fe80::1')).toBe(true));
  it('allows 2001:4860:4860::8888 (Google)', () => expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false));

  // ── IPv4-mapped IPv6 ─────────────────────────────────────────────────────
  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)',
    () => expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true));
  it('blocks ::ffff:192.168.1.1 (IPv4-mapped RFC1918)',
    () => expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true));
  it('allows ::ffff:1.1.1.1 (IPv4-mapped public)',
    () => expect(isPrivateAddress('::ffff:1.1.1.1')).toBe(false));

  // ── Malformed input ───────────────────────────────────────────────────────
  it('blocks malformed input (safety fallback)',
    () => expect(isPrivateAddress('not-an-ip')).toBe(true));
});

// ── SsrfGuard.checkIp ─────────────────────────────────────────────────────────

describe('SsrfGuard.checkIp', () => {

  it('throws SsrfError for private IPv4', () => {
    expect(() =>
      SsrfGuard.checkIp('127.0.0.1', SsrfPolicy.BLOCK_PRIVATE),
    ).toThrow(SsrfError);
  });

  it('throws SsrfError for AWS IMDS', () => {
    expect(() =>
      SsrfGuard.checkIp('169.254.169.254', SsrfPolicy.BLOCK_PRIVATE),
    ).toThrow(SsrfError);
  });

  it('throws SsrfError for RFC 1918 10.x', () => {
    expect(() =>
      SsrfGuard.checkIp('10.0.0.1', SsrfPolicy.BLOCK_PRIVATE),
    ).toThrow(SsrfError);
  });

  it('includes hostname in the error when provided', () => {
    let caught: SsrfError | null = null;
    try {
      SsrfGuard.checkIp('127.0.0.1', SsrfPolicy.BLOCK_PRIVATE, 'internal.corp');
    } catch (e) {
      if (e instanceof SsrfError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.hostname).toBe('internal.corp');
    expect(caught?.resolvedIp).toBe('127.0.0.1');
    expect(caught?.message).toMatch('internal.corp');
    expect(caught?.message).toMatch('127.0.0.1');
  });

  it('does not throw for a public IP', () => {
    expect(() =>
      SsrfGuard.checkIp('93.184.216.34', SsrfPolicy.BLOCK_PRIVATE),
    ).not.toThrow();
  });

  it('does not throw for any IP when policy is ALLOW_ALL', () => {
    expect(() =>
      SsrfGuard.checkIp('127.0.0.1', SsrfPolicy.ALLOW_ALL),
    ).not.toThrow();
    expect(() =>
      SsrfGuard.checkIp('169.254.169.254', SsrfPolicy.ALLOW_ALL),
    ).not.toThrow();
  });
});

// ── SsrfGuard.check (async, uses real dns.lookup) ─────────────────────────────
// These tests require network access. They are skipped in offline environments.

describe('SsrfGuard.check', () => {

  it('blocks localhost via DNS resolution', async () => {
    await expect(
      SsrfGuard.check('localhost', SsrfPolicy.BLOCK_PRIVATE),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('throws (fail-closed) when DNS resolution fails entirely', async () => {
    await expect(
      SsrfGuard.check('this-domain-does-not-exist-xyz-abc-123.invalid', SsrfPolicy.BLOCK_PRIVATE),
    ).rejects.toThrow();
  });

  it('ALLOW_ALL skips DNS and never throws', async () => {
    await expect(
      SsrfGuard.check('localhost', SsrfPolicy.ALLOW_ALL),
    ).resolves.toBeUndefined();
  });
});
