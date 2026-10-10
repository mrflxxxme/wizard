// V3-23: the runtime reads the key window's keys from the platform's encrypted secret file (fileSecretReader) — only
// connector paths <system id>/<env>/<name>, the file re-read on each call, the M0 env variables as the fallback.
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ConnectorError,
  fileSecretReader,
  readSecretFileEntry,
  secretFileKey,
  staticSecretReader,
} from "../src/index.js";

const SYSTEM = "0b8f7c2e-1111-4222-8333-944445555666";

/** Writes entries the way platform-api's SecretStore does (AES-256-GCM, the path as AAD). */
function writeFile(file: string, key: Buffer, entries: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(entries)) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(path));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    out[path] = Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  writeFileSync(file, JSON.stringify({ v: 1, entries: out }));
}

describe("V3-23 connector secrets from the platform's secret file", () => {
  test("the system's keys of its environment; another environment, an unknown system or a platform path — missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-secret-file-"));
    const file = join(dir, "secrets.enc");
    const key = secretFileKey(file, "test-key-material") as Buffer;
    writeFile(file, key, {
      [`${SYSTEM}/draft/yookassa_shop_id`]: "123456",
      [`${SYSTEM}/draft/yookassa_secret_key`]: "test_secret",
      [`${SYSTEM}/prod/yookassa_secret_key`]: "live_secret",
      "platform/staff/totp/u1": "JBSWY3DPEHPK3PXP",
    });
    const reader = (env: "draft" | "prod", id: string | null = SYSTEM) =>
      fileSecretReader({ file, keyMaterial: "test-key-material", env, systemUuid: async () => id });
    expect(await reader("draft").get("yookassa_shop_id")).toBe("123456");
    expect(await reader("draft").get("yookassa_secret_key")).toBe("test_secret");
    expect(await reader("prod").get("yookassa_secret_key")).toBe("live_secret");
    await expect(reader("prod").get("yookassa_shop_id")).rejects.toMatchObject({ code: "SECRET_MISSING" });
    await expect(reader("draft", null).get("yookassa_shop_id")).rejects.toBeInstanceOf(ConnectorError);
    // Never the platform's own secrets: neither by a name with a path nor through a crafted system id.
    await expect(reader("draft").get("../platform/staff/totp/u1")).rejects.toMatchObject({
      code: "SECRET_MISSING",
    });
    await expect(reader("draft", "platform").get("staff")).rejects.toMatchObject({ code: "SECRET_MISSING" });
    // Re-read on each call: a key replaced in the window applies at once.
    writeFile(file, key, { [`${SYSTEM}/draft/yookassa_shop_id`]: "654321" });
    expect(await reader("draft").get("yookassa_shop_id")).toBe("654321");
  });

  test("the M0 env variables when the file lacks the name; no key or no file — the fallback only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-secret-file-"));
    const file = join(dir, "secrets.enc");
    const fallback = staticSecretReader({ telegram_bot_token: "from-env" });
    const r = fileSecretReader({
      file,
      keyMaterial: "",
      env: "draft",
      systemUuid: async () => SYSTEM,
      fallback,
    });
    expect(await r.get("telegram_bot_token")).toBe("from-env");
    await expect(r.get("yookassa_shop_id")).rejects.toMatchObject({ code: "SECRET_MISSING" });
    // The local random key next to the file (platform-api without WIZARD_SECRETS_KEY) is used the same way.
    const ikm = randomBytes(32);
    writeFileSync(`${file}.key`, ikm);
    const key = secretFileKey(file, "") as Buffer;
    writeFile(file, key, { [`${SYSTEM}/draft/yookassa_shop_id`]: "777" });
    expect(await r.get("yookassa_shop_id")).toBe("777");
    expect(readSecretFileEntry(file, key, `${SYSTEM}/draft/none`)).toBeNull();
  });
});
