// Staff MFA primitives (M2-08): RFC 6238 appendix B vectors (SHA1), RFC 4648 base32, the ±1 step window with replay
// guard, recovery-code hashing.
import { describe, expect, test } from "vitest";
import { deriveKey } from "../src/auth/crypto.js";
import {
  base32Decode,
  base32Encode,
  hotp,
  matchRecovery,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryHash,
  totpCode,
  totpStep,
  verifyTotp,
} from "../src/auth/totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238)", () => {
  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("appendix B, SHA1, T=%i → %s", (t, code) => {
    expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
    expect(totpCode(base32Encode(RFC_SECRET), t * 1000)).toBe(code.slice(2));
  });

  test("base32 round trip (RFC 4648 «foobar» vector)", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw 6ytb-oi======").toString()).toBe("foobar");
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(() => base32Decode("01!")).toThrow();
  });

  test("window ±1 step; older and replayed steps refused", () => {
    const s = newTotpSecret();
    const now = Date.UTC(2026, 9, 1, 12, 0, 10);
    const step = totpStep(now);
    expect(verifyTotp(s, totpCode(s, now), { at: now })).toBe(step);
    expect(verifyTotp(s, totpCode(s, now - 30_000), { at: now })).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, now + 30_000), { at: now })).toBe(step + 1);
    const old = totpCode(s, now - 90_000);
    if (old !== totpCode(s, now) && old !== totpCode(s, now - 30_000) && old !== totpCode(s, now + 30_000))
      expect(verifyTotp(s, old, { at: now })).toBeNull();
    expect(verifyTotp(s, totpCode(s, now), { at: now, lastStep: step })).toBeNull();
    expect(verifyTotp(s, "12345", { at: now })).toBeNull();
    expect(verifyTotp(s, "abcdef", { at: now })).toBeNull();
  });

  test("otpauth URI for authenticator apps", () => {
    const u = new URL(otpauthUri("JBSWY3DPEHPK3PXP", "founder@wizard.example"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(u.searchParams.get("period")).toBe("30");
    expect(u.searchParams.get("digits")).toBe("6");
  });

  test("recovery codes: hashed per user, normalized match", () => {
    const key = deriveKey("test-key", "staff-recovery");
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const hashes = codes.map((c) => recoveryHash(key, "u1", c));
    expect(
      matchRecovery(key, "u1", ` ${(codes[3] as string).toUpperCase().replace("-", " ")} `, hashes),
    ).toBe(3);
    expect(matchRecovery(key, "u2", codes[3] as string, hashes)).toBe(-1);
    expect(matchRecovery(key, "u1", "zzzzz-zzzzz", hashes)).toBe(-1);
  });
});
