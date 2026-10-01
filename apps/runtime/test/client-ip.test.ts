// L3-27 (platform/deploy.yaml#cloud.client_ip): the client IP is the hop appended by a trusted ingress (CIDRs of
// WIZARD_TRUSTED_PROXIES); X-Forwarded-For from an untrusted peer is ignored; IPv6 limits count per /64. server.ts
// computes rememberClientIp(effectiveClientIp(peer, XFF, trusted)) and limits key on clientNetwork() of it.
import { effectiveClientIp } from "@wizard/connectors";
import { describe, expect, it } from "vitest";
import { clientNetwork } from "../src/auth/keys.js";
import { readEnv } from "../src/index.js";

const INGRESS = ["10.112.0.0/16", "fd00:10::/64"];
const limitKey = (peer: string, xff: string | null) => clientNetwork(effectiveClientIp(peer, xff, INGRESS));

describe("client IP behind the ingress", () => {
  it("XFF from an untrusted peer does not change the limit key", () => {
    const base = limitKey("203.0.113.7", null);
    for (const xff of ["1.1.1.1", "8.8.8.8, 9.9.9.9", "10.112.0.5", "garbage", "2001:db8::1"]) {
      expect(limitKey("203.0.113.7", xff)).toBe(base);
    }
    expect(base).toBe("203.0.113.7");
  });

  it("from the trusted ingress: the last hop it appended, not client-supplied entries", () => {
    // The client sent "XFF: 6.6.6.6"; the ingress appended the real peer 198.51.100.20.
    expect(limitKey("10.112.3.4", "6.6.6.6, 198.51.100.20")).toBe("198.51.100.20");
    // Chained trusted hops are skipped from the right.
    expect(limitKey("10.112.3.4", "6.6.6.6, 198.51.100.20, 10.112.9.9")).toBe("198.51.100.20");
    // A malformed hop means the header is not believed: the ingress itself is the client.
    expect(limitKey("10.112.3.4", "6.6.6.6, not-an-ip")).toBe("10.112.3.4");
    // No XFF from the ingress → its own address.
    expect(limitKey("10.112.3.4", null)).toBe("10.112.3.4");
  });

  it("IPv6 clients are limited per /64, IPv4-mapped addresses as IPv4", () => {
    const a = limitKey("fd00:10::1", "2001:db8:aa:bb:1::1");
    const b = limitKey("fd00:10::2", "2001:db8:aa:bb:ffff:ffff:ffff:fffe");
    const c = limitKey("fd00:10::1", "2001:db8:aa:bc::1");
    expect(a).toBe("2001:db8:aa:bb::/64");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(limitKey("::ffff:203.0.113.7", null)).toBe("203.0.113.7");
  });

  it("WIZARD_TRUSTED_PROXIES is a comma-separated CIDR list; empty → XFF never trusted", () => {
    expect(readEnv({ WIZARD_TRUSTED_PROXIES: " 10.112.0.0/16, fd00:10::/64 " }).trustedProxies).toEqual(
      INGRESS,
    );
    const none = readEnv({}).trustedProxies ?? [];
    expect(none).toEqual([]);
    expect(effectiveClientIp("10.112.3.4", "198.51.100.20", none)).toBe("10.112.3.4");
  });
});
