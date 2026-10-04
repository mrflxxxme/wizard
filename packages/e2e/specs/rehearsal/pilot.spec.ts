// The pilot's first day on a DEPLOYED environment (docs/founder/pilot-checklist.md §9), through the public ingress only:
// the founder signs in by the code from the letter, the bootstrap Job makes the account staff, MFA in /admin, beta
// readiness with the D25 note, an invitation → the client signs in by the letter's link → S-welcome → a «форум» is
// built (G0 + G1 in the gVisor sandbox of the cluster) → the first prod publication waits for the founder's review →
// the founder approves in /admin → the system answers on its own domain. Letters are read from Mailpit
// (tools/deploy/local.mjs); nothing here reaches the database directly.
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const WEB = process.env.WIZARD_E2E_WEB ?? "https://wizard.localhost";
const MAIL = process.env.WIZARD_E2E_MAILPIT ?? "http://127.0.0.1:8025";
const FOUNDER = process.env.WIZARD_E2E_FOUNDER ?? "founder@wizard.localhost";
const SYSTEMS = process.env.WIZARD_E2E_SYSTEMS ?? "wsys.localhost";
const CLIENT = `client-${randomBytes(3).toString("hex")}@example.test`;
const ORG = "Кофейня «Зерно»";
// The scenario keeps the founder's TOTP secret and staff session on disk and acts as the founder: a real environment
// only on purpose (WIZARD_E2E_ALLOW_REMOTE=1, e.g. a staging rehearsal), never by a stray WIZARD_E2E_WEB.
if (!new URL(WEB).hostname.endsWith(".localhost") && process.env.WIZARD_E2E_ALLOW_REMOTE !== "1")
  throw new Error(
    `${WEB}: not a local rehearsal; set WIZARD_E2E_ALLOW_REMOTE=1 to run against a real environment`,
  );

// Founder's TOTP secret and session between runs (git-ignored .data of the rehearsal).
const REPO = join(import.meta.dirname, "../../../..");
const STATE_DIR = process.env.WIZARD_E2E_STATE_DIR ?? join(REPO, ".data/local");
const TOTP_FILE = join(STATE_DIR, "founder-totp.secret");
const FOUNDER_STATE = join(STATE_DIR, "founder-session.json");

test.describe.configure({ mode: "serial" });

let founder: BrowserContext;
let client: BrowserContext;
let systemId = "";
let systemHost = "";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Json = any;

/** Newest letter to `to` in Mailpit whose text matches `re`, received after `since`. */
async function letter(to: string, re: RegExp, since: number): Promise<string> {
  let text = "";
  await expect
    .poll(
      async () => {
        const q = encodeURIComponent(`to:"${to}"`);
        const list = (await (await fetch(`${MAIL}/api/v1/search?query=${q}`)).json()) as Json;
        for (const m of list.messages ?? []) {
          if (Date.parse(m.Created) < since) continue;
          const full = (await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json()) as Json;
          if (re.test(full.Text ?? "")) {
            text = full.Text;
            return true;
          }
        }
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return text;
}

/** Brief of the golden «форум» (tools/fixtures/golden/forum.yaml), as forum.spec.ts types it. */
function goldenBrief(): string {
  const y = readFileSync(join(import.meta.dirname, "../../../../tools/fixtures/golden/forum.yaml"), "utf8");
  const m = y.match(/^brief: >-\r?\n((?: {2}.*\r?\n)+)/m);
  if (!m?.[1]) throw new Error("brief not found in golden/forum.yaml");
  return m[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/** RFC 6238 code (SHA-1, 30 s, 6 digits) of a base32 secret — what an authenticator app shows. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h.readUInt8(h.length - 1) & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function api(ctx: BrowserContext) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const csrf = (await ctx.cookies(WEB)).find(
      (c) => c.name === "__Host-wizard_csrf" || c.name === "wizard_csrf",
    )?.value;
    const res = await ctx.request.fetch(`${WEB}/api/v1${path}`, {
      method,
      headers: {
        Origin: WEB,
        ...(csrf && method !== "GET" ? { "X-Wizard-CSRF": csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status(), body: text.startsWith("{") ? JSON.parse(text) : text };
  };
}

/** Sign-in by e-mail code on S-auth; a new user (the form shows the consents) ticks both. */
async function signIn(page: Page, email: string): Promise<void> {
  const since = Date.now() - 1000;
  if (!/\/login/.test(page.url())) await page.goto("/login");
  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-request-code").click();
  await expect(page.getByRole("status")).toContainText("Если адрес верный, код отправлен");
  const code = (await letter(email, /\b\d{6}\b/, since)).match(/\b\d{6}\b/)?.[0] ?? "";
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  const offer = page.getByTestId("auth-offer");
  await Promise.race([
    offer.waitFor({ timeout: 15_000 }),
    page.waitForURL((u) => !u.pathname.startsWith("/login")),
  ]);
  if (await offer.isVisible()) {
    await offer.check();
    await page.getByTestId("auth-pd-consent").check();
    await page.getByTestId("auth-submit").click();
  }
  await expect(page).not.toHaveURL(/\/login/);
}

test.beforeAll(async ({ browser }) => {
  // The founder's session survives between runs: repeated codes for one address hit the OTP rate limit (by design).
  founder = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "ru-RU",
    ...(existsSync(FOUNDER_STATE) ? { storageState: FOUNDER_STATE } : {}),
  });
  client = await browser.newContext({ ignoreHTTPSErrors: true, locale: "ru-RU" });
});

test.afterAll(async () => {
  await founder?.close();
  await client?.close();
});

test("основатель: вход по коду из письма, права staff от Job выката, MFA в /admin", async () => {
  const info = test.info();
  test.setTimeout(180_000);
  const page = await founder.newPage();
  // First run: the founder is new (invited by the Job); later runs sign in as an existing user. Right after a fresh
  // release the Job may not have written the invitation yet (its first psql races the NetworkPolicy; retry in 30 s).
  const signedIn = (await api(founder)("GET", "/me")).status === 200;
  for (let attempt = 1; !signedIn; attempt++) {
    await page.goto(`${WEB}/login`);
    try {
      await signIn(page, FOUNDER);
      break;
    } catch (e) {
      const refused = await page.getByTestId("auth-error").isVisible();
      if (!refused || attempt >= 4) throw e;
      await page.waitForTimeout(30_000);
    }
  }
  // The Job polls every 30 s and grants is_staff after the first sign-in.
  await expect
    .poll(async () => (await api(founder)("GET", "/me")).body?.user?.isStaff, { timeout: 90_000 })
    .toBe(true);
  await founder.storageState({ path: FOUNDER_STATE });
  await page.goto(`${WEB}/admin`);
  const start = page.getByTestId("admin-mfa-start");
  const verify = page.getByTestId("admin-verify");
  await expect(start.or(verify).or(page.getByTestId("admin-tab-pilot"))).toBeVisible();
  if (await start.isVisible()) {
    // Enrolment: the secret is what the founder would scan; kept for the next runs (git-ignored .data).
    await start.click();
    const secret = (await page.getByTestId("admin-mfa-secret").getAttribute("data-secret")) ?? "";
    mkdirSync(dirname(TOTP_FILE), { recursive: true });
    writeFileSync(TOTP_FILE, secret, { mode: 0o600 });
    await page.getByTestId("admin-mfa-code").fill(totp(secret));
    await page.getByTestId("admin-mfa-confirm").click();
    await page.getByTestId("admin-recovery-done").click();
  } else if (await verify.isVisible()) {
    await page.getByTestId("admin-mfa-code").fill(totp(readFileSync(TOTP_FILE, "utf8").trim()));
    await page.getByTestId("admin-mfa-verify").click();
  }
  await expect(page.getByTestId("admin-tab-pilot")).toBeVisible();
  await page.screenshot({ path: info.outputPath("admin.png"), fullPage: true });
});

test("основатель: готовность беты с заметкой D25 и приглашение клиента из /admin", async () => {
  const page = await founder.newPage();
  await page.goto(`${WEB}/admin`);
  await page.getByTestId("admin-tab-pilot").click();
  const readiness = page.getByTestId("admin-pilot-readiness");
  if ((await readiness.getAttribute("data-on")) !== "true") {
    await page.getByTestId("admin-pilot-readiness-note").fill("D25 пилот без юр. обвязки");
    await page.getByTestId("admin-pilot-readiness-toggle").click();
    await page.getByTestId("admin-pilot-readiness-toggle").click();
    await expect(readiness).toHaveAttribute("data-on", "true");
  }
  await page.getByTestId("admin-pilot-invite-email").fill(CLIENT);
  await page.getByTestId("admin-pilot-invite-org").fill(ORG);
  await page.getByTestId("admin-pilot-invite-credits").fill("150");
  await page.getByTestId("admin-pilot-invite-submit").click();
  await expect(page.getByTestId("admin-pilot-invite-done")).toContainText(CLIENT);
});

test("клиент: вход по ссылке из письма → онбординг пилота", async () => {
  const info = test.info();
  const link =
    (await letter(CLIENT, /\/login\?email=/, Date.now() - 120_000)).match(/https:\/\/\S+/)?.[0] ?? "";
  expect(link).toContain(`${WEB}/login?email=`);
  const page = await client.newPage();
  await page.goto(link);
  await expect(page.getByTestId("auth-email")).toHaveValue(CLIENT);
  await signIn(page, CLIENT);
  await expect(page).toHaveURL(`${WEB}/welcome`);
  await expect(page.getByTestId("welcome-org")).toContainText(ORG);
  await expect(page.getByTestId("welcome-credits")).toContainText("150");
  await page.screenshot({ path: info.outputPath("welcome.png"), fullPage: true });
});

test("клиент: сборка «форума» — G0 и G1 в песочнице кластера", async () => {
  const info = test.info();
  test.setTimeout(420_000);
  const req = api(client);
  const me = await req("GET", "/me");
  const orgId = me.body.memberships.find((m: Json) => m.role === "owner").orgId;
  await req("PATCH", `/orgs/${orgId}`, { regionCode: "77" });
  // The client's path of the golden «форум» (forum.spec.ts): brief → button questions → card → «Строить».
  const page = await client.newPage();
  await page.goto(`${WEB}/`);
  await page.getByTestId("start-prompt").fill(goldenBrief());
  await page.getByTestId("start-submit").click();
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  systemId = page.url().split("/s/")[1] ?? "";
  await expect(page.getByTestId("question-card")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath("questions.png"), fullPage: true });
  await page.getByTestId("question-option-email_or_telegram").click();
  await page.getByTestId("question-next").click();
  await page.getByTestId("question-option-qr_offline_scanner").click();
  await page.getByTestId("question-next").click();
  await page.getByTestId("question-accept-rest").click();
  await expect(page.getByTestId("card")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath("card.png"), fullPage: true });
  await page.getByTestId("card-build").click();
  // G1 runs the system's functions and pages in workerd pods under gVisor (M2-19) — the cluster path, not unsafe-local.
  await expect(page.getByTestId("gate-row-G0")).toHaveAttribute("data-status", "passed", {
    timeout: 240_000,
  });
  await expect(page.getByTestId("gate-row-G1")).toHaveAttribute("data-status", "passed", {
    timeout: 240_000,
  });
  await expect(page.getByTestId("run-error")).toHaveCount(0);
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await expect(page.frameLocator('[data-testid="preview-frame"]').getByTestId("wz-appshell")).toContainText(
    "Северный ритейл",
    { timeout: 60_000 },
  );
  await page.screenshot({ path: info.outputPath("preview.png"), fullPage: true });
});

test("клиент публикует → ревью основателя → одобрение в /admin → система живёт на своём домене", async () => {
  const info = test.info();
  test.setTimeout(420_000);
  const req = api(client);
  const sys = (await req("GET", `/systems/${systemId}`)).body;
  const put = await req("PUT", `/systems/${systemId}/compliance`, {
    expectedVersion: sys.system.draftRevision,
    operatorName: "ООО «Северный ритейл»",
    operatorContact: "privacy@north-retail.example",
    operatorAddress: "г. Москва, ул. Тверская, д. 1",
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  // PROD values of the integrations (G2-SECRET-02): the product has no owner screen for them yet, the operator puts
  // them (tools/deploy/local.mjs secrets, the same SecretStore as the platform) — a known pilot gap, see the runbook.
  const out = execFileSync(process.execPath, [join(REPO, "tools/deploy/local.mjs"), "secrets", systemId], {
    cwd: REPO,
    encoding: "utf8",
  });
  info.annotations.push({ type: "operator", description: out.trim().split("\n").at(-1) ?? "" });
  const page = await client.newPage();
  await page.goto(`${WEB}/s/${systemId}`);
  const blockers = (await req("GET", `/systems/${systemId}`)).body.publishBlockers;
  info.annotations.push({ type: "publishBlockers", description: JSON.stringify(blockers) });
  await page.screenshot({ path: info.outputPath("before-publish.png"), fullPage: true });
  await page.getByTestId("publish-submit").click();
  await expect(page.getByRole("alert").filter({ hasText: "посмотрит модератор" })).toBeVisible({
    timeout: 240_000,
  });

  const admin = await founder.newPage();
  await admin.goto(`${WEB}/admin`);
  await admin.getByTestId("admin-tab-reviews").click();
  const row = admin.getByTestId("admin-review-row").first();
  await expect(row).toBeVisible();
  await row.getByTestId("admin-review-approve").click();

  await page.reload();
  await page.getByTestId("publish-submit").click();
  await expect(page.getByTestId("publish-prod-revision")).toBeVisible({ timeout: 240_000 });
  const after = (await req("GET", `/systems/${systemId}`)).body.system;
  systemHost = `${after.slug}.${SYSTEMS}`;
  const live = await client.request.get(`https://${systemHost}/`);
  expect(live.status()).toBe(200);
  const site = await client.newPage();
  await site.goto(`https://${systemHost}/`);
  await site.screenshot({ path: info.outputPath("live.png"), fullPage: true });
});
