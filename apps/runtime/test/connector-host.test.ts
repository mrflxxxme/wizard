// M0-24: dev QR signing key for local drafts (docs/reviews/impl-notes/M0-24.md) — generated once, 0600, reused.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQrKeyring, staticSecretReader } from "@wizard/connectors";
import { afterAll, expect, test } from "vitest";
import { devQrSecretReader } from "../src/preview/connectors.js";

const dir = mkdtempSync(join(tmpdir(), "wz-rt-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("missing qr_signing_key → generated keyring persisted with mode 0600 and reused", async () => {
  const a = devQrSecretReader(staticSecretReader({}), join(dir, "s"), "abc123abc123");
  const value = await a.get("qr_signing_key");
  expect(parseQrKeyring(value).keys.length).toBe(1);
  expect(statSync(join(dir, "s", "abc123abc123.json")).mode & 0o777).toBe(0o600);
  const b = devQrSecretReader(staticSecretReader({}), join(dir, "s"), "abc123abc123");
  expect(await b.get("qr_signing_key")).toBe(value);
});

test("a configured secret wins; other missing secrets still fail with SECRET_MISSING", async () => {
  const r = devQrSecretReader(staticSecretReader({ qr_signing_key: "configured" }), dir, "abc123abc123");
  expect(await r.get("qr_signing_key")).toBe("configured");
  await expect(
    devQrSecretReader(staticSecretReader({}), dir, "k").get("smtp_password"),
  ).rejects.toMatchObject({
    code: "SECRET_MISSING",
  });
});
