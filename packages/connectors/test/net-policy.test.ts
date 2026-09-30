// SSRF address classification, guarded fetch, reserved system slugs and the invitation quota (L3-24, L3-29).
import { describe, expect, test } from "vitest";
import {
  consumeInviteQuota,
  guardedFetch,
  INVITES_PER_DAY,
  isPrivateAddress,
  isReservedSystemSlug,
  platformConfigFromEnv,
  qrPng,
  RESERVED_SYSTEM_SLUGS,
} from "../src/index.js";
import { MemoryStore } from "../src/testing.js";

describe("isPrivateAddress", () => {
  test.each([
    "10.0.0.5",
    "127.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:5",
    "ff02::1",
    "not-an-ip",
  ])("%s is not public", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  test.each([
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2a00:1450:4010:c05::64",
    "::ffff:93.184.216.34",
  ])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("guardedFetch", () => {
  const ok = (async () => new Response("ok")) as typeof fetch;

  test("private resolution and plain http are refused; trusted hosts pass", async () => {
    const f = guardedFetch({
      resolve: async () => ["10.1.2.3"],
      inner: ok,
      trustedHosts: ["127.0.0.1:9999"],
    });
    await expect(f("https://internal.example/x")).rejects.toMatchObject({ code: "EGRESS_DISABLED" });
    await expect(f("http://example.ru/")).rejects.toMatchObject({ code: "EGRESS_DISABLED" });
    expect((await f("http://127.0.0.1:9999/bot1/getMe")).status).toBe(200);
    const pub = guardedFetch({ resolve: async () => ["93.184.216.34"], inner: ok });
    expect((await pub("https://api.example.ru/")).status).toBe(200);
  });
});

describe("system slugs and invitations (L3-29)", () => {
  test("mail/infrastructure names are reserved", () => {
    for (const s of ["www", "mail", "smtp", "mx", "mta-sts", "autodiscover", "autoconfig", "api", "admin"]) {
      expect(isReservedSystemSlug(s)).toBe(true);
    }
    for (const s of ["status", "static", "cdn", "abuse", "security", "wizard"])
      expect(isReservedSystemSlug(s)).toBe(true);
    expect(RESERVED_SYSTEM_SLUGS.size).toBe(15);
    expect(isReservedSystemSlug("forum-north")).toBe(false);
  });

  test("≤ 5 a day on Free, ≤ 20 on paid plans, per system", async () => {
    let now = new Date("2026-10-01T09:00:00Z");
    const store = new MemoryStore(() => now);
    const ctx = (plan: "free" | "paid") => ({ store, now: () => now, system: { plan } as never });
    for (let i = 0; i < INVITES_PER_DAY.free; i++) await consumeInviteQuota(ctx("free"));
    await expect(consumeInviteQuota(ctx("free"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const paidStore = new MemoryStore(() => now);
    const paid = { store: paidStore, now: () => now, system: { plan: "paid" } as never };
    for (let i = 0; i < INVITES_PER_DAY.paid; i++) await consumeInviteQuota(paid);
    await expect(consumeInviteQuota(paid)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    now = new Date("2026-10-02T00:00:01Z");
    await consumeInviteQuota(ctx("free"));
  });
});

test("platformConfigFromEnv: shared bot, platform SMTP, dev receiver only locally", async () => {
  const env = {
    WIZARD_TELEGRAM_BOT_TOKEN: "t",
    WIZARD_TELEGRAM_BOT_USERNAME: "wizard_notify_bot",
    WIZARD_SMTP_HOST: "smtp.provider.example",
    WIZARD_SMTP_PORT: "587",
    WIZARD_SMTP_USER: "noreply",
    WIZARD_DEV_SMTP: "1",
  };
  const cfg = platformConfigFromEnv(env, { systemsDomain: "systems.example", local: false });
  expect(await cfg.secrets.get("telegram_bot_token")).toBe("t");
  await expect(cfg.secrets.get("telegram_webhook_secret")).rejects.toMatchObject({ code: "SECRET_MISSING" });
  expect(cfg.telegram).toEqual({ apiBase: "https://api.telegram.org", botUsername: "wizard_notify_bot" });
  expect(cfg.smtp).toEqual({ host: "smtp.provider.example", port: 587, tls: "starttls", user: "noreply" });
  expect(cfg.devSmtp).toBeNull();
  expect(cfg.mailDomain).toBe("systems.example");
  expect(platformConfigFromEnv(env, { systemsDomain: "x", local: true }).devSmtp).toMatchObject({
    port: 1025,
    tls: "none",
  });
});

test("qrPng: valid PNG signature and square size", () => {
  const png = qrPng("WZ1.1.ABCDEFGHIJKLMNOPQRSTUVWXYZ.sig");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
});
