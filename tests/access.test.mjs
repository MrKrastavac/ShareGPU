import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedAddress, parseAddress, tokensMatch, consumeRate } from "../src/access.mjs";

test("allows the configured LAN and RFC1918 ranges", () => {
  for (const addr of ["127.0.0.1", "192.168.0.50", "10.8.0.7", "::1"]) {
    assert.equal(isAllowedAddress(addr), true, addr);
  }
});

test("covers the whole Tailscale CGNAT range, which is not octet-aligned", () => {
  // 100.64.0.0/10 spans 100.64.x - 100.127.x. A naive /8 or /16 match would
  // either miss real peers or wrongly admit 100.128+.
  for (const addr of ["100.64.0.1", "100.100.20.30", "100.127.255.254"]) {
    assert.equal(isAllowedAddress(addr), true, addr);
  }
  for (const addr of ["100.63.255.255", "100.128.0.1", "101.64.0.1"]) {
    assert.equal(isAllowedAddress(addr), false, addr);
  }
});

test("allows the whole private space by default, not just one subnet", () => {
  // A router terminating WireGuard often puts peers on a different subnet from
  // the LAN, so a narrow default silently refuses them. Narrowing is done with
  // --allow once you know your own ranges.
  for (const addr of ["192.168.1.5", "192.168.3.7", "172.16.0.1"]) {
    assert.equal(isAllowedAddress(addr), true, addr);
  }
});

test("refuses public addresses", () => {
  for (const addr of ["8.8.8.8", "203.0.113.9", "1.1.1.1", "172.32.0.1"]) {
    assert.equal(isAllowedAddress(addr), false, addr);
  }
});

test("an IPv4-mapped IPv6 address is judged on its IPv4 value", () => {
  // The classic bypass: ::ffff:8.8.8.8 must not pass merely by being v6.
  assert.equal(isAllowedAddress("::ffff:192.168.0.9"), true);
  assert.equal(isAllowedAddress("::ffff:8.8.8.8"), false);
  assert.equal(parseAddress("::ffff:192.168.0.9").version, 4);
});

test("malformed addresses are refused rather than defaulting open", () => {
  for (const addr of ["", "garbage", "999.1.1.1", "192.168.0", null, undefined]) {
    assert.equal(isAllowedAddress(addr), false, String(addr));
  }
});

test("token comparison rejects mismatches and empty values", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch(null, "abc"), false);
  assert.equal(tokensMatch("abc", null), false);
});

test("the rate limiter drains a burst then refuses", () => {
  const id = `test-${Math.random()}`;
  let allowed = 0;
  for (let i = 0; i < 200; i += 1) if (consumeRate(id).ok) allowed += 1;
  assert.ok(allowed > 0, "should allow the initial burst");
  assert.ok(allowed < 200, "should refuse once the bucket empties");
  const denied = consumeRate(id);
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter > 0, "should say when to retry");
});

test("rate limit buckets are per client", () => {
  const a = `a-${Math.random()}`;
  const b = `b-${Math.random()}`;
  while (consumeRate(a).ok) { /* drain a */ }
  assert.equal(consumeRate(b).ok, true, "b must be unaffected by a");
});
