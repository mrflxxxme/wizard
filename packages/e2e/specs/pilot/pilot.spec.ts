// M2-15 / M2-09 on the pilot stand (stand/pilot.ts: M2 rules, WIZARD_REGISTRATION=invite, WIZARD_PAYMENTS=off,
// founder review on, no shop), in order: a new e-mail without an invitation is refused in Russian on S-auth; the
// founder's CLI refuses `pilot invite` until `pilot readiness on` (beta_readiness, M2-13), then sends the letter → its
// link opens S-auth with the address → OTP + consents → S-welcome (pilot onboarding) → a template opens S1 of the
// pilot org; S-billing shows the plan «Пилот» and the invited credits without purchase, subscriptions or card; a
// «форум» is built and published to prod without a card: the first publication waits for the founder's review, the
// moderation CLI path approves it, the next attempt goes live. Then the staff console «Пилот» (pilot-admin): the
// founder (staff with TOTP) switches beta_readiness off and on again (note + second press), is refused while it is off,
// invites a client from /admin — the client signs in by the letter's link and lands on S-welcome; the invitation turns
// «принято» and the org shows up in the pilot table, where the founder grants credits by a reference.
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
  setStaff,
  totpCode,
} from "@wizard/platform-api";
import { PILOT, PILOT_DB_FILE, PILOT_OUTBOX } from "../../stand/ports.js";
import {
  type Api,
  api,
  builtForum,
  devLogin,
  type Json,
  ownerOrg,
  setOperator,
  uniqueEmail,
} from "../m1/helpers.js";

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

const pilotCli = (argv: string[]) =>
  withStandDb((h) =>
    runPilotCli(argv, {
      db: h.db,
      billing: new Billing(),
      mailer: new OutboxMailer(PILOT_OUTBOX),
      platformOrigin: WEB,
      llmMonthlyCapRub: 6000,
    }),
  );

test("приглашение CLI основателя → письмо со ссылкой → вход → онбординг пилота → организация на тарифе «Пилот»", async () => {
  // beta_readiness (M2-09): no partner invitations until the founder records M2-13 as done.
  const invite = ["invite", owner, "--org-name", "Кофейня «Зерно»", "--credits", "100"];
  await expect(pilotCli(invite)).rejects.toThrow("Приглашать партнёров пока нельзя");
  expect(letters(owner, "invite")).toHaveLength(0);
  expect(await pilotCli(["readiness", "on", "--by", "e2e", "--note", "M2-13 выполнена"])).toMatch(
    /^beta_readiness: on \(e2e, /,
  );
  const out = await pilotCli(invite);
  expect(out).toContain(`приглашение отправлено: ${owner}`);
  const letter = await lastLetter(owner, "invite");
  expect(letter).toContain("посмотрит модератор");
  const link = letter.match(/https?:\/\/\S+/)?.[0] ?? "";
  expect(link).toBe(`${WEB}/login?email=${encodeURIComponent(owner)}&next=%2Fwelcome`);

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
  // S-welcome: the pilot explained in Russian — free, credits, limits, review before the first publication.
  await expect(page).toHaveURL(`${WEB}/welcome`);
  await expect(page.getByTestId("welcome-title")).toHaveText("Добро пожаловать в пилот Wizard");
  await expect(page.getByTestId("welcome-org")).toContainText("Кофейня «Зерно»");
  await expect(page.getByTestId("welcome-free")).toContainText("Оплата и привязка карты не нужны");
  await expect(page.getByTestId("welcome-credits")).toContainText("Сейчас доступно: 100 кредитов");
  await expect(page.getByTestId("welcome-limits")).toContainText("До 5 опубликованных систем");
  await expect(page.getByTestId("welcome-review")).toContainText("посмотрит модератор");
  // A template opens S1 with its description; S1 links back to the onboarding.
  await page.getByTestId("welcome-template-event_registration").click();
  await expect(page).toHaveURL(`${WEB}/?template=event_registration`);
  await expect(page.getByTestId("start-prompt")).toHaveValue(/Мероприятие: регистрация участников/);
  await expect(page.getByTestId("start-template-event_registration")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("start-org")).toContainText("Кофейня «Зерно»");
  await expect(page.getByTestId("start-pilot-about")).toHaveText("Как устроен пилот");

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
  // M2-09: the first prod publication of a pilot org waits for the founder's review (orgs.require_founder_review).
  await expect(review).toBeVisible({ timeout: 150_000 });
  await expect(prod).toHaveCount(0);
  const revision = (await a.req("GET", `/systems/${system.id}`)).body.system.draftRevision as number;
  const blocked = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(blocked.publishBlockers).toEqual(["FOUNDER_REVIEW_PENDING"]);
  expect(blocked.system.prodRevision).toBeNull();
  // The founder approves (the moderation CLI path), the owner publishes again.
  expect(
    await withStandDb((h) =>
      decideFounderReview(h.db, { systemId: system.id, revision, decision: "approve", note: "e2e pilot" }),
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByTestId("publish-blocker")).toHaveCount(0);
  await page.getByTestId("publish-submit").click();
  await expect(prod).toBeVisible({ timeout: 150_000 });
  const after = (await a.req("GET", `/systems/${system.id}`)).body;
  expect(after.system.prodRevision).toBe(after.system.draftRevision);
  // No card was ever bound.
  expect((await a.req("GET", `/orgs/${orgId}`)).body.cardBound).toBe(false);
  await page.close();
});

test("консоль «Пилот»: готовность беты, приглашение клиента из /admin → вход клиента → S-welcome", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // The founder's account as on the pilot (bootstrap Job: one invitation, then is_staff after the first sign-in).
  const founder = uniqueEmail("pilot-founder");
  await withStandDb(async (h) => {
    await h.db
      .insertInto("platform.pilot_invites")
      .values({ email: founder, credits: 0, expires_at: new Date(Date.now() + 86_400_000) })
      .execute();
  });
  const staffCtx = await browser.newContext({ baseURL: WEB, locale: "ru-RU" });
  await devLogin(staffCtx, founder, WEB);
  await withStandDb((h) => setStaff(h.db, founder, true));
  const admin = await staffCtx.newPage();
  await admin.goto("/admin");
  await admin.getByTestId("admin-mfa-start").click();
  const secret = (await admin.getByTestId("admin-mfa-secret").getAttribute("data-secret")) ?? "";
  await admin.getByTestId("admin-mfa-code").fill(totpCode(secret));
  await admin.getByTestId("admin-mfa-confirm").click();
  await admin.getByTestId("admin-recovery-done").click();
  await admin.getByTestId("admin-tab-pilot").click();

  // beta_readiness was recorded by the CLI above (same flag): who/when are shown; switching off is one press.
  const readiness = admin.getByTestId("admin-pilot-readiness");
  await expect(readiness).toHaveAttribute("data-on", "true");
  await expect(admin.getByTestId("admin-pilot-readiness-by")).toContainText("Переключил e2e");
  await expect(admin.getByTestId("admin-pilot-checklist").locator("li")).toHaveCount(5);
  await admin.getByTestId("admin-pilot-readiness-toggle").click();
  await expect(readiness).toHaveAttribute("data-on", "false");

  // While it is off the invitation is refused with the same Russian text as the CLI.
  const client = uniqueEmail("pilot-client");
  await admin.getByTestId("admin-pilot-invite-email").fill(client);
  await admin.getByTestId("admin-pilot-invite-org").fill("Пекарня «Колос»");
  await admin.getByTestId("admin-pilot-invite-credits").fill("40");
  await admin.getByTestId("admin-pilot-invite-submit").click();
  await expect(admin.getByTestId("admin-pilot-invite-error")).toContainText(
    "Приглашать партнёров пока нельзя",
  );
  expect(letters(client, "invite")).toHaveLength(0);

  // On: a note and a second press with the consequences.
  await admin.getByTestId("admin-pilot-readiness-note").fill("M2-13: РКН, юрист, поручения — готово");
  await admin.getByTestId("admin-pilot-readiness-toggle").click();
  await expect(admin.getByTestId("admin-pilot-readiness-confirm-text")).toContainText("Нажмите ещё раз");
  await admin.getByTestId("admin-pilot-readiness-toggle").click();
  await expect(readiness).toHaveAttribute("data-on", "true");
  await expect(admin.getByTestId("admin-pilot-readiness-by")).toContainText(`Переключил ${founder}`);

  // The invitation from the console (the form kept the address).
  await expect(admin.getByTestId("admin-pilot-invite-review")).toBeChecked();
  await admin.getByTestId("admin-pilot-invite-submit").click();
  await expect(admin.getByTestId("admin-pilot-invite-done")).toContainText(client);
  const row = admin.getByTestId("admin-pilot-invite-row").filter({ hasText: client });
  await expect(row).toHaveAttribute("data-status", "sent");
  const letter = await lastLetter(client, "invite");
  const link = letter.match(/https?:\/\/\S+/)?.[0] ?? "";
  expect(link).toBe(`${WEB}/login?email=${encodeURIComponent(client)}&next=%2Fwelcome`);
  await expect(admin.getByTestId("admin-pilot-invite-link")).toHaveText(link);

  // The client signs in by the link → S-welcome of the pilot org.
  const clientCtx = await browser.newContext({ baseURL: WEB, locale: "ru-RU" });
  const page = await clientCtx.newPage();
  await page.goto(link);
  await expect(page.getByTestId("auth-email")).toHaveValue(client);
  const code = await requestCode(page, client);
  await page.getByTestId("auth-code").fill(code);
  await page.getByTestId("auth-submit").click();
  await page.getByTestId("auth-offer").check();
  await page.getByTestId("auth-pd-consent").check();
  await page.getByTestId("auth-submit").click();
  await expect(page).toHaveURL(`${WEB}/welcome`);
  await expect(page.getByTestId("welcome-org")).toContainText("Пекарня «Колос»");
  await expect(page.getByTestId("welcome-credits")).toContainText("Сейчас доступно: 40 кредитов");
  await expect(page.getByTestId("welcome-review")).toContainText("посмотрит модератор");

  // The console: the invitation is accepted, the org is in the pilot table; a grant by reference.
  await admin.reload();
  await admin.getByTestId("admin-tab-pilot").click();
  await expect(admin.getByTestId("admin-pilot-invite-row").filter({ hasText: client })).toHaveAttribute(
    "data-status",
    "accepted",
  );
  const org = admin.getByTestId("admin-pilot-org-row").filter({ hasText: "Пекарня «Колос»" });
  await expect(org.getByTestId("admin-pilot-org-available")).toHaveText("40");
  await expect(org.getByTestId("admin-pilot-org-review")).toBeChecked();
  await org.getByTestId("admin-pilot-grant-credits").fill("10");
  await org.getByTestId("admin-pilot-grant-reference").fill("e2e договор 1");
  await org.getByTestId("admin-pilot-grant").click();
  await expect(org.getByTestId("admin-pilot-org-notice")).toHaveText("Начислено. Доступно: 50 кр.");
  await expect(admin.getByTestId("admin-pilot-spend")).toHaveAttribute("data-warn", "false");
  const journal = await withStandDb((h) =>
    h.db
      .selectFrom("platform.staff_audit_log")
      .select(["action"])
      .where("action", "like", "pilot_%")
      .orderBy("id")
      .execute(),
  );
  expect(journal.map((j) => j.action)).toEqual([
    "pilot_readiness_off",
    "pilot_readiness_on",
    "pilot_invite",
    "pilot_grant",
  ]);
  await clientCtx.close();
  await staffCtx.close();
});
