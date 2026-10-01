// M2-15 on the pilot stand (stand/pilot.ts: M2 rules, WIZARD_REGISTRATION=invite, WIZARD_PAYMENTS=off, no shop), in
// order: a new e-mail without an invitation is refused in Russian on S-auth; the founder's CLI (`pilot invite`) sends
// the letter → its link opens S-auth with the address → OTP + consents → S1 of the pilot org; S-billing shows the plan
// «Пилот» and the invited credits without purchase, subscriptions or card; a «форум» is built and published to prod
// without a card (G1 + G2 at publish, founder review approved by the moderation CLI path).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  Billing,
  createDb,
  decideFounderReview,
  OutboxMailer,
  runPilotCli,
  SecretStore,
} from "@wizard/platform-api";
import { PILOT, PILOT_DB_FILE, PILOT_OUTBOX } from "../../stand/ports.js";
import { type Api, api, builtForum, type Json, ownerOrg, setOperator, uniqueEmail } from "../m1/helpers.js";

const WEB = `http://localhost:${PILOT.web}`;

test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let a: Api;
let orgId: string;
let system: Json;
const owner = uniqueEmail("pilot-owner");

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: WEB, locale: "ru-RU" });
});

test.afterAll(async () => {
  await ctx?.close();
});

/** The stand's own database (stand.ts writes its URL at start). */
async function withStandDb<T>(fn: (h: ReturnType<typeof createDb>, url: string) => Promise<T>): Promise<T> {
  const url = readFileSync(PILOT_DB_FILE, "utf8").trim();
  const h = createDb(url, 1);
  try {
    return await fn(h, url);
  } finally {
    await h.close();
  }
}

/** Letters of the pilot stand's OutboxMailer to `to` of `kind`, newest last. */
function letters(to: string, kind: string): { text: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(PILOT_OUTBOX).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => JSON.parse(readFileSync(join(PILOT_OUTBOX, n), "utf8")))
    .filter((l) => l.to === to && l.kind === kind);
}

async function lastLetter(to: string, kind: string, after = 0): Promise<string> {
  let text = "";
  await expect
    .poll(() => {
      const all = letters(to, kind);
      text = all.length > after ? (all.at(-1)?.text ?? "") : "";
      return text;
    })
    .not.toBe("");
  return text;
}

async function requestCode(page: Page, email: string): Promise<string> {
  const before = letters(email, "otp").length;
  await page.getByTestId("auth-request-code").click();
  await expect(page.getByRole("status")).toContainText("Если адрес верный, код отправлен");
  const code = (await lastLetter(email, "otp", before)).match(/\b\d{6}\b/)?.[0] ?? "";
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

/** Prod values of the forum's integration secrets (G2-SECRET-02 at publish), as in specs/m2/billing.spec.ts. */
async function setIntegrationSecrets(systemId: string): Promise<void> {
  const forumFile = join(import.meta.dirname, "../../../../specs/appspec/examples/forum.json");
  const forum = JSON.parse(readFileSync(forumFile, "utf8")) as { integrations: { secretRefs?: string[] }[] };
  const names = forum.integrations
    .flatMap((i) => i.secretRefs ?? [])
    .map((r) => r.replace(/^secret:\/\//, ""));
  await withStandDb(async (h, url) => {
    const artifacts = join(dirname(PILOT_DB_FILE), `artifacts-${new URL(url).pathname.slice(1)}`);
    const store = new SecretStore(join(artifacts, ".secrets.enc"), process.env.WIZARD_SECRETS_KEY ?? "");
    await h.db.transaction().execute(async (trx) => {
      for (const name of names)
        await store.put(trx, { orgId, systemId, env: "prod", name, value: `e2e-${name}` });
    });
  });
}

test("S-auth: новый email без приглашения основателя → понятный отказ на русском", async () => {
  const page = await ctx.newPage();
  const email = uniqueEmail("stranger");
  await page.goto("/login");
  await page.getByTestId("auth-email").fill(email);
  const code = await requestCode(page, email);
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("auth-error")).toContainText(
    "Регистрация в Wizard пока только по приглашению",
  );
  // The refusal comes before the consents: nothing to tick, no account.
  await expect(page.getByTestId("auth-offer")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login/);
  await page.close();
});

test("приглашение CLI основателя → письмо со ссылкой → вход → организация на тарифе «Пилот»", async () => {
  const out = await withStandDb((h) =>
    runPilotCli(["invite", owner, "--org-name", "Кофейня «Зерно»", "--credits", "100"], {
      db: h.db,
      billing: new Billing(),
      mailer: new OutboxMailer(PILOT_OUTBOX),
      platformOrigin: WEB,
      llmMonthlyCapRub: 6000,
    }),
  );
  expect(out).toContain(`приглашение отправлено: ${owner}`);
  const letter = await lastLetter(owner, "invite");
  const link = letter.match(/https?:\/\/\S+/)?.[0] ?? "";
  expect(link).toBe(`${WEB}/login?email=${encodeURIComponent(owner)}`);

  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByTestId("auth-email")).toHaveValue(owner);
  const code = await requestCode(page, owner);
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  // A new user still gives both consents (compliance.yaml#platform).
  await page.getByTestId("auth-offer").check();
  await page.getByTestId("auth-pd-consent").check();
  await page.getByTestId("auth-submit").click();
  await expect(page).toHaveURL(`${WEB}/`);
  await expect(page.getByTestId("start-prompt")).toBeVisible();
  await expect(page.getByTestId("start-org")).toContainText("Кофейня «Зерно»");

  a = api(ctx, WEB);
  orgId = await ownerOrg(a);
  const org = await a.req("GET", `/orgs/${orgId}`);
  expect(org.body).toMatchObject({ plan: "pilot", name: "Кофейня «Зерно»", paymentsEnabled: false });
  await page.close();
});

test("S-billing: тариф «Пилот» и баланс видны, покупки, подписок и привязки карты нет", async () => {
  const page = await ctx.newPage();
  await page.goto("/billing");
  await expect(page.getByTestId("billing-payments-off")).toContainText("Оплата на пилоте отключена");
  await expect(page.getByTestId("billing-plan")).toHaveAttribute("data-plan", "pilot");
  await expect(page.getByTestId("billing-plan")).toContainText("Пилот");
  await expect(page.getByTestId("billing-available")).toHaveAttribute("data-value", "100");
  await expect(page.getByTestId("billing-bucket")).toContainText("от команды Wizard: 100");
  await expect(page.getByTestId("billing-ledger-row").first()).toHaveAttribute("data-kind", "grant");
  for (const id of ["billing-topup", "billing-card", "billing-card-bind", "billing-change-plan"])
    await expect(page.getByTestId(id)).toHaveCount(0);
  // The API agrees: payment operations are off.
  const topup = await a.req("POST", `/orgs/${orgId}/billing/topups`, { packs: 1 });
  expect(topup.status).toBe(403);
  expect(topup.body.code).toBe("PAYMENTS_DISABLED");
  await page.close();
});

test("сборка «форума» и публикация в prod без привязки карты", async () => {
  test.setTimeout(300_000);
  system = await builtForum(a, orgId);
  await setOperator(a, system);
  await setIntegrationSecrets(system.id);
  const sys = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(sys.publishBlockers).not.toContain("CARD_BINDING_REQUIRED");

  const page = await ctx.newPage();
  await page.goto(`/s/${system.id}`);
  await expect(page.getByTestId("publish-card-status")).toHaveText(
    "Сейчас публикация доступна без привязки карты",
  );
  await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
  await expect(page.getByTestId("publish-submit")).toBeEnabled();
  await page.getByTestId("publish-submit").click();
  const prod = page.getByTestId("publish-prod-revision");
  const review = page.getByRole("alert").filter({ hasText: "посмотрит модератор" });
  await expect(prod.or(review)).toBeVisible({ timeout: 150_000 });
  if (!(await prod.isVisible())) {
    // G2 warning (abuse.yaml#scoring.effect): the founder approves (the moderation CLI path), publish again.
    const revision = (await a.req("GET", `/systems/${system.id}`)).body.system.draftRevision as number;
    expect(
      await withStandDb((h) =>
        decideFounderReview(h.db, { systemId: system.id, revision, decision: "approve", note: "e2e pilot" }),
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
    await page.getByTestId("publish-submit").click();
    await expect(prod).toBeVisible({ timeout: 150_000 });
  }
  const after = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(after.system.prodRevision).toBe(after.system.draftRevision);
  // No card was ever bound.
  expect((await a.req("GET", `/orgs/${orgId}`)).body.cardBound).toBe(false);
  await page.close();
});
