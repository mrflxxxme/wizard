// AC2 (M0-28): sign/verify per qr.yaml#token; forged signature → bad_signature; kid rotation.
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  base32,
  newQrKeyring,
  parseQrKeyring,
  parseQrPayload,
  QR_GRACE_MS,
  qrTokenHash,
  rotateQrKeyring,
  serializeQrKeyring,
  signQrToken,
  verifyQrToken,
} from "../src/index.js";

const scope = { systemId: "sys_forum", env: "draft" as const };
const DAY = 24 * 60 * 60_000;
const t0 = new Date("2026-10-01T10:00:00Z");

describe("payload format", () => {
  test("WZ1.<kid>.<rand 26 base32>.<sig 16 base64url>, ≤ 64 chars", () => {
    const ring = newQrKeyring();
    const p = signQrToken(ring, scope);
    expect(p).toMatch(/^WZ1\.1\.[A-Z2-7]{26}\.[A-Za-z0-9_-]{16}$/);
    expect(p.length).toBeLessThanOrEqual(64);
    const parsed = parseQrPayload(p);
    expect(parsed?.kid).toBe(1);
  });

  test("sig = base64url(HMAC-SHA256(key, 'WZ1|system|env|rand'))[0:16]", () => {
    const ring = newQrKeyring();
    const p = signQrToken(ring, scope);
    const { rand, sig } = parseQrPayload(p) ?? { rand: "", sig: "" };
    const expected = createHmac("sha256", ring.keys[0]?.key as Uint8Array)
      .update(`WZ1|sys_forum|draft|${rand}`)
      .digest("base64url")
      .slice(0, 16);
    expect(sig).toBe(expected);
  });

  test("base32 of 16 bytes is 26 chars (RFC 4648 vector)", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32(new Uint8Array(16))).toHaveLength(26);
  });

  test("random parts are unique", () => {
    const ring = newQrKeyring();
    const set = new Set(Array.from({ length: 500 }, () => signQrToken(ring, scope)));
    expect(set.size).toBe(500);
  });
});

describe("verification", () => {
  const ring = newQrKeyring();
  const payload = signQrToken(ring, scope);

  test("valid payload verifies", () => {
    expect(verifyQrToken(payload, ring, scope, t0)).toMatchObject({ ok: true, kid: 1 });
  });

  test("any single changed character → bad_signature", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567abcxyz019_-.";
    for (let i = 0; i < payload.length; i++) {
      const ch = payload[i] as string;
      const repl = alphabet.split("").find((c) => c !== ch) as string;
      const forged = payload.slice(0, i) + repl + payload.slice(i + 1);
      expect(verifyQrToken(forged, ring, scope, t0), forged).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  test("payload of another system or env → bad_signature", () => {
    expect(verifyQrToken(payload, ring, { ...scope, systemId: "sys_other" }, t0).ok).toBe(false);
    expect(verifyQrToken(payload, ring, { ...scope, env: "prod" }, t0).ok).toBe(false);
  });

  test("another key → bad_signature; garbage → bad_signature", () => {
    expect(verifyQrToken(payload, newQrKeyring(), scope, t0).ok).toBe(false);
    for (const g of [
      "",
      "WZ1",
      "WZ1.1..",
      `${payload}x`,
      "WZ2.1.AAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA",
    ]) {
      expect(verifyQrToken(g, ring, scope, t0)).toEqual({ ok: false, reason: "bad_signature" });
    }
  });
});

describe("rotation", () => {
  test("new kid signs; previous kid accepted for 30 days, then rejected", () => {
    const ring1 = newQrKeyring();
    const old = signQrToken(ring1, scope);
    const ring2 = rotateQrKeyring(ring1, { now: t0 });
    const fresh = signQrToken(ring2, scope);
    expect(parseQrPayload(fresh)?.kid).toBe(2);
    expect(verifyQrToken(fresh, ring2, scope, t0).ok).toBe(true);
    expect(verifyQrToken(old, ring2, scope, new Date(t0.getTime() + 29 * DAY)).ok).toBe(true);
    expect(verifyQrToken(old, ring2, scope, new Date(t0.getTime() + QR_GRACE_MS + 1)).ok).toBe(false);
    // Tokens signed by the new key are not accepted by the old ring (unknown kid).
    expect(verifyQrToken(fresh, ring1, scope, t0).ok).toBe(false);
  });

  test("re-signing keeps rand and moves to the active kid", () => {
    const ring1 = newQrKeyring();
    const old = signQrToken(ring1, scope);
    const ring2 = rotateQrKeyring(ring1, { now: t0 });
    const { rand } = parseQrPayload(old) ?? { rand: "" };
    const resigned = signQrToken(ring2, scope, rand);
    expect(parseQrPayload(resigned)).toMatchObject({ kid: 2, rand });
  });

  test("leaked key: previous kid is rejected at once", () => {
    const ring1 = newQrKeyring();
    const old = signQrToken(ring1, scope);
    const ring2 = rotateQrKeyring(ring1, { now: t0, compromised: true });
    expect(verifyQrToken(old, ring2, scope, t0).ok).toBe(false);
    expect(verifyQrToken(signQrToken(ring2, scope), ring2, scope, t0).ok).toBe(true);
  });

  test("third rotation drops keys past the grace period", () => {
    const r1 = newQrKeyring();
    const r2 = rotateQrKeyring(r1, { now: t0 });
    const r3 = rotateQrKeyring(r2, { now: new Date(t0.getTime() + 40 * DAY) });
    expect(r3.keys.map((k) => k.kid)).toEqual([2, 3]);
  });

  test("keyring survives the secret round trip; a bare 32-byte key is kid 1", () => {
    const ring = rotateQrKeyring(newQrKeyring(), { now: t0 });
    const back = parseQrKeyring(serializeQrKeyring(ring));
    const p = signQrToken(ring, scope);
    expect(verifyQrToken(p, back, scope, t0).ok).toBe(true);
    const bare = Buffer.alloc(32, 7).toString("base64url");
    expect(parseQrKeyring(bare)).toMatchObject({ activeKid: 1 });
    expect(() => parseQrKeyring(Buffer.alloc(8).toString("base64url"))).toThrow();
  });

  test("revocation hash is 22 base64url chars of sha256(rand)", () => {
    expect(qrTokenHash("AAAAAAAAAAAAAAAAAAAAAAAAAA")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
