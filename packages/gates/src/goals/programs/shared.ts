// Helpers shared by goal scenario programs: ui-kit selectors and spec lookups by the modules' canonical names.
import type { AppSpec } from "@wizard/appspec";
import type { FilledForm, GoalRun } from "../types.js";

/** Root of a ui-kit component in the DOM (useWzRoot → data-wz-component). */
export const component = (name: string) => `[data-wz-component="${name}"]`;

/** Label of an enum value of an entity field (e.g. lead.status new → «Новая»). */
export function enumLabel(spec: AppSpec, entity: string, field: string, value: string): string {
  const f = spec.entities.find((e) => e.name === entity)?.fields.find((x) => x.name === field);
  return f?.enum?.find((o) => o.value === value)?.label ?? value;
}

/** Route of the section root an actor role may open: the shortest route starting with `prefix` (default the cabinet). */
export function pageRoute(spec: AppSpec, role: string, prefix = "/cabinet"): string | null {
  // The shortest matching route is the section root (/cabinet before /cabinet/notifications), whatever the page order.
  const routes = (spec.pages ?? [])
    .filter((p) => p.roles.includes(role) && p.route.startsWith(prefix))
    .map((p) => p.route);
  return routes.sort((a, b) => a.length - b.length)[0] ?? null;
}

/**
 * Whether a page source works with an entity: a ui-kit component (DataTable, RecordForm, StatusBoard … entity="x"),
 * or a section of a v3 page whose props name it (the composer writes them as JSON: "entity":"x", V3-18).
 */
const showsEntity = (source: string, entity: string) =>
  source.includes(`entity={"${entity}"}`) ||
  source.includes(`entity="${entity}"`) ||
  source.includes(`"entity":"${entity}"`);

/**
 * Page of a role that works with an entity: a page whose source names the entity, routes under `prefix` first (the
 * cabinet), then any; null — the role has no such page.
 */
export function entityPage(
  t: GoalRun,
  role: string,
  entity: string,
  prefix = "/cabinet",
): { route: string; file: string } | null {
  const pages = (t.spec.pages ?? []).filter(
    (p) => p.roles.includes(role) && showsEntity(t.files.get(p.file) ?? "", entity),
  );
  const p = pages.find((x) => x.route.startsWith(prefix)) ?? pages[0];
  return p ? { route: p.route, file: p.file } : null;
}

/**
 * Opens the page of the current actor's role with an entity and its section (tab) when the page has sections.
 * Returns the selector of the area that holds the entity (the open tab panel or the page's body).
 */
export async function openEntity(t: GoalRun, role: string, entity: string, prefix?: string): Promise<string> {
  const page = entityPage(t, role, entity, prefix);
  if (!page) return t.fail(`у роли «${role}» нет страницы с разделом «${entityLabel(t.spec, entity)}»`);
  await t.open(page.route);
  if (await openSection(t, entity)) return '[role="tabpanel"]';
  return "body";
}

const IMPORT_RE = /import\s+(\w+)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g;

/** A relative import of a file of the system resolved against the importing file («ui/pages/site» + «../../x»). */
function resolveImport(from: string, spec: string): string {
  const out = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

/**
 * Whether a page file renders a component of the DOM contract `name`: the ui-kit component itself (`<LeadForm`, v2),
 * or a file of the system it imports and renders — a v3 pattern (ui/patterns/*) or section — whose root carries
 * data-wz-component="<name>".
 */
export function rendersComponent(files: ReadonlyMap<string, string>, file: string, name: string): boolean {
  const src = files.get(file) ?? "";
  if (src.includes(`<${name}`)) return true;
  for (const [, local, spec] of src.matchAll(IMPORT_RE)) {
    if (!local || !spec || !src.includes(`<${local}`)) continue;
    const path = resolveImport(file, spec);
    const dep = files.get(path) ?? files.get(`${path}.tsx`) ?? files.get(`${path}.ts`);
    if (dep?.includes(`data-wz-component="${name}"`)) return true;
  }
  return false;
}

/** Route of the public page with the lead form (the landing «/» first): v2 `<LeadForm`, or a v3 lead form pattern. */
export function leadFormRoute(t: GoalRun): string | null {
  const pages = (t.spec.pages ?? []).filter((p) => rendersComponent(t.files, p.file, "LeadForm"));
  return (pages.find((p) => p.route === "/") ?? pages[0])?.route ?? null;
}

/** Steps a form may have (a v3 stepper: «Ваш запрос», then «Как с вами связаться»). */
const MAX_FORM_STEPS = 4;

/**
 * Fills and sends the form inside `within` like a person: every field filled, consents ticked, sent. A form in steps
 * (data-wz-step / data-wz-steps of the v3 patterns) is filled step by step — «Далее» until its last step is sent; a
 * one-step form (every v2 form) is filled and sent once.
 */
export async function sendForm(t: GoalRun, within: string): Promise<FilledForm> {
  const filled: FilledForm = {};
  for (let i = 0; i < MAX_FORM_STEPS; i++) {
    Object.assign(filled, await t.fillForm(within));
    const form = t.page.locator(`${within} form`).first();
    const step = Number((await form.getAttribute("data-wz-step").catch(() => null)) ?? "0");
    const steps = Number((await form.getAttribute("data-wz-steps").catch(() => null)) ?? "0");
    if (!(step > 0 && step < steps)) {
      await t.submit(within);
      return filled;
    }
    // «Далее» of a step: no write yet, the next step's fields come in its place.
    await form.locator('button[type="submit"]').first().click();
    await t.settle();
    const at = async () => Number((await form.getAttribute("data-wz-step").catch(() => null)) ?? "0");
    for (let k = 0; k < 15 && (await at()) === step; k++) await t.page.waitForTimeout(200);
    if ((await at()) === step)
      t.fail(`форма не перешла к шагу ${step + 1} из ${steps}`, await textOf(t, within));
  }
  return t.fail(`у формы больше ${MAX_FORM_STEPS} шагов`);
}

/** A visitor leaves a lead on the lead form page (every field filled, consent ticked) and sees «Заявка отправлена». */
export async function leaveLead(t: GoalRun): Promise<FilledForm> {
  const route = leadFormRoute(t);
  if (!route) return t.fail("на сайте нет формы заявки");
  await t.open(route);
  const form = component("LeadForm");
  const filled = await sendForm(t, form);
  await t.expectText("Заявка отправлена", { within: form });
  return filled;
}

/** Label of an entity (as the system names it). */
export const entityLabel = (spec: AppSpec, entity: string) =>
  spec.entities.find((e) => e.name === entity)?.label ?? entity;

/** Name of the admin (owner) role. */
export const ownerRole = (spec: AppSpec) =>
  spec.roles.find((r) => r.isAdmin === true && r.access !== "public")?.name ?? "owner";

/** String values (≥ 4 characters) of seed rows: none of them may be shown to someone without access. */
export function seedTexts(t: GoalRun, entity: string, limit = 5): string[] {
  const out: string[] = [];
  for (const r of t.seedRows(entity).slice(0, limit))
    for (const [k, v] of Object.entries(r))
      if (k !== "id" && typeof v === "string" && v.length >= 4 && !/^\d{4}-\d\d-\d\d/.test(v)) out.push(v);
  return out;
}

/** The text a visitor sees, normalised (spaces collapsed). */
export async function pageText(t: GoalRun): Promise<string> {
  return (
    (await t.page
      .locator("body")
      .innerText()
      .catch(() => "")) || ""
  ).replace(/\s+/g, " ");
}

const SPACES = /[\s  ]+/g;

/** Normalised text of the first match of a selector (spaces collapsed) or "" when it is absent. */
export async function textOf(t: GoalRun, selector: string): Promise<string> {
  const loc = t.page.locator(selector).first();
  if ((await loc.count()) === 0) return "";
  return ((await loc.innerText({ timeout: 2_000 }).catch(() => "")) || "").replace(SPACES, " ").trim();
}

/** Opens a section (tab) of a CabinetLayout page when the page has it. */
export async function openSection(t: GoalRun, id: string): Promise<boolean> {
  const tab = t.page.locator(`[data-testid="wz-cabinet-tab-${id}"]`).first();
  if ((await tab.count()) === 0) return false;
  await tab.click();
  await t.settle();
  return true;
}

/** Ids of the sections (tabs) of the CabinetLayout on the page. */
export async function sectionIds(t: GoalRun): Promise<string[]> {
  const ids = await t.page
    .locator('[data-testid^="wz-cabinet-tab-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid")?.slice("wz-cabinet-tab-".length) ?? ""),
    );
  return ids.filter(Boolean);
}

/** Clicks a visible button (or a link styled as one) by its exact caption inside `within`. */
export async function press(t: GoalRun, caption: string, within?: string): Promise<void> {
  const scope = within ? t.page.locator(within).first() : t.page.locator("body");
  const button = scope.getByRole("button", { name: caption, exact: true }).first();
  const target =
    (await button.count()) > 0 ? button : scope.getByRole("link", { name: caption, exact: true }).first();
  if ((await target.count()) === 0) t.fail(`на экране нет кнопки «${caption}»`);
  await target.click();
  await t.settle();
}

/** Waits for the form inside `within` and for its selects' options (ref fields load them from the server). */
export async function formReady(t: GoalRun, within: string): Promise<void> {
  const form = t.page.locator(`${within} form`).first();
  try {
    await form.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("форма не появилась на экране");
  }
  await t.page
    .waitForFunction(
      (sel) =>
        [...(document.querySelector(sel)?.querySelectorAll("select") ?? [])].every(
          (s) => (s as HTMLSelectElement).options.length > 1,
        ),
      `${within} form`,
      { timeout: 1_500 },
    )
    .catch(() => {});
}

/** Sets fields of the form inside `within` by field name (ui-kit marks each field wz-field-<name>). */
export async function setFields(
  t: GoalRun,
  within: string,
  values: Readonly<Record<string, string | boolean>>,
): Promise<void> {
  for (const [name, v] of Object.entries(values)) {
    const root = t.page.locator(`${within} [data-testid="wz-field-${name}"]`).first();
    if ((await root.count()) === 0) t.fail(`в форме нет поля «${name}»`);
    const select = root.locator("select").first();
    if ((await select.count()) > 0) {
      await select.selectOption(String(v));
      continue;
    }
    const radio = root.locator(`input[type="radio"][value="${String(v)}"]`).first();
    if ((await radio.count()) > 0) {
      await radio.check({ force: true });
      continue;
    }
    const input = root.locator("input, textarea").first();
    if (typeof v === "boolean") await input.setChecked(v, { force: true });
    else await input.fill(v);
  }
}

/** A cabinet form flow: «Добавить» inside `within`, every field filled, `values` on top, saved without errors. */
export async function addRecord(
  t: GoalRun,
  within: string,
  values: Readonly<Record<string, string | boolean>> = {},
  caption = "Добавить",
): Promise<void> {
  await press(t, caption, within);
  // RecordForm's root is the <form> itself: the area that holds it is the scope.
  await formReady(t, within);
  await t.fillForm(within);
  await setFields(t, within, values);
  await t.submit(within);
  const error = await textOf(t, `${within} form [role="alert"]`);
  if (error) t.fail("запись не сохранилась", error);
}

/** Text of the smallest visible row or card (tr, li, article, a ui-kit component) showing `anchor`; null — none. */
export async function blockText(t: GoalRun, anchor: string, within?: string): Promise<string | null> {
  return t.page.evaluate(
    ([a, w]) => {
      const root = (w ? document.querySelector(w) : document.body) ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.includes(a)) continue;
        const el = n.parentElement;
        if (!el || el.getClientRects().length === 0) continue;
        const box =
          el.closest('tr, li, article, [data-testid$="card"], [data-wz-component]') ?? el.parentElement ?? el;
        return ((box as HTMLElement).innerText ?? "").replace(/[\s  ]+/g, " ").trim();
      }
      return null;
    },
    [anchor, within ?? null] as const,
  );
}

/** «1 500 ₽» in any spacing (ui-kit formats money with non-breaking spaces). */
export const rubles = (n: number): RegExp =>
  new RegExp(`${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\\s?")}\\s?₽`);

/** The text with every kind of space collapsed to one ASCII space. */
export const plain = (s: string) => s.replace(SPACES, " ").trim();

/** Code of the last login message (e-mail or SMS) to `to` since the run started. */
export function loginCode(t: GoalRun, to: string): string | null {
  const low = to.toLowerCase();
  const digits = to.replace(/\D/g, "").slice(-10);
  for (const m of [...t.serviceMessages()].reverse()) {
    const p = (m.payload ?? {}) as { to?: unknown; text?: unknown; subject?: unknown };
    const dest = String(p.to ?? "").toLowerCase();
    if (dest !== low && dest.replace(/\D/g, "").slice(-10) !== digits) continue;
    const code = /\b(\d{6})\b/.exec(`${String(p.subject ?? "")} ${String(p.text ?? "")}`)?.[1];
    if (code) return code;
  }
  return null;
}

/** Whether a role signs in by a code on the phone only (else by e-mail). */
export const phoneLogin = (spec: AppSpec, role: string) => {
  const methods = spec.roles.find((x) => x.name === role)?.loginMethods ?? [];
  return !methods.includes("email_otp") && methods.includes("phone_otp");
};

/**
 * Signs in on /login by a one-time code like a person: the run's contact (e-mail or phone by the role's login
 * methods), the code from the platform's message, consent when asked. Ends on `next`.
 */
export async function signInByCode(t: GoalRun, role: string, next: string): Promise<void> {
  const phone = phoneLogin(t.spec, role);
  const to = phone ? t.contact.phone : t.contact.email;
  await t.open(`/login?${new URLSearchParams({ role, next })}`);
  const method = t.page.locator(`[data-testid="wz-login-method-${phone ? "phone_otp" : "email_otp"}"]`);
  if ((await method.count()) > 0) {
    await method.first().click();
    await t.settle();
  }
  const field = t.page.locator(`[data-testid="wz-field-${phone ? "phone" : "email"}"] input`).first();
  if ((await field.count()) === 0) t.fail("на странице входа нет поля для почты или телефона");
  await field.fill(to);
  await t.page.locator('[data-testid="wz-login-submit"]').first().click();
  await t.settle();
  const codeField = t.page.locator('[data-testid="wz-field-code"] input').first();
  try {
    await codeField.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("код входа не отправлен", await textOf(t, '[data-testid="wz-login"]'));
  }
  const code = loginCode(t, to);
  if (!code) t.fail(`код входа не пришёл ${phone ? "по SMS" : "на почту"}`);
  await codeField.fill(code);
  // A first login asks for consent to personal data processing after the code (CONSENT_REQUIRED): tick it, send again.
  const consent = t.page.locator('[data-testid="wz-consent"] input[type="checkbox"]').first();
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await consent.count()) > 0 && !(await consent.isChecked())) await consent.check({ force: true });
    await t.page.locator('[data-testid="wz-login-submit"]').first().click();
    // Either the login goes on to `next`, or the form asks for consent (it appears with an alert).
    const left = await Promise.race([
      t.page.waitForURL((u) => u.pathname !== "/login", { timeout: 8_000 }).then(() => true),
      t.page
        .locator('[data-testid="wz-login"] [role="alert"]')
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => false),
    ]).catch(() => false);
    if (left || new URL(t.page.url()).pathname !== "/login") break;
    if (attempt === 1) t.fail("вход по коду не удался", await textOf(t, '[data-testid="wz-login"]'));
  }
  await t.settle();
}

/** Presses an action of the open RecordCard (status changes are to_<value>, wz-recordcard-action-<id>). */
export async function recordAction(t: GoalRun, within: string, id: string): Promise<void> {
  const button = t.page.locator(`${within} [data-testid="wz-recordcard-action-${id}"]`).first();
  try {
    await button.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("в карточке записи нет нужного действия", id);
  }
  const write = t.page
    .waitForResponse((r) => r.request().method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/"), {
      timeout: 3_000,
    })
    .catch(() => null);
  await button.click();
  await write;
  await t.settle();
}

/** A runtime request with the page's own session (an actor who signed in on the page, not a seed session). */
export async function pageApi(
  t: GoalRun,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return t.page.evaluate(
    async ([m, p, b]) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (m !== "GET") {
        headers["content-type"] = "application/json";
        headers["x-wizard-request"] = "1";
      }
      const r = await fetch(p, {
        method: m,
        credentials: "same-origin",
        headers,
        ...(b === null ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body === undefined ? null : body] as const,
  );
}
