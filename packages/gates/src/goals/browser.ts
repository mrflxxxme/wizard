// G1 browser checks (specs/quality/gates.yaml#G1.browser, D76 (6)): the draft of the system opens in Chromium with every
// request answered by the runtime handle of G1 (no network, no port), on the seed of the ephemeral schema.
// G1-GOAL-<scenario id> — goal scenarios of the plan's modules at 390 and 1280 px in the light and dark themes;
// G1-MOBILE-01 — every page × each of its roles at 390 px without horizontal scroll.
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { CHECK_BY_ID, type CheckDef } from "../catalog.js";
import type { Actor, G1Env } from "../g1/env.js";
import { routePathFor } from "../g1/render/index.js";
import type { Seed } from "../g1/types.js";
import { clip, type Finding, toChecks } from "../report.js";
import type { Check } from "../types.js";
import { GOAL_PROGRAMS } from "./programs/index.js";
import {
  type ColorScheme,
  type FilledForm,
  GoalFailure,
  type GoalOutboxMessage,
  type GoalProgram,
  type GoalRun,
  type GoalScenarioInput,
  type GoalViewport,
} from "./types.js";

export const MOBILE_VIEWPORT: GoalViewport = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT: GoalViewport = { width: 1280, height: 800 };
/** Scenario matrix (modules.yaml#manifest.goal_scenarios.run): 390 and 1280 px × light and dark. */
export const GOAL_MATRIX: readonly { viewport: GoalViewport; scheme: ColorScheme }[] = [
  { viewport: MOBILE_VIEWPORT, scheme: "light" },
  { viewport: MOBILE_VIEWPORT, scheme: "dark" },
  { viewport: DESKTOP_VIEWPORT, scheme: "light" },
  { viewport: DESKTOP_VIEWPORT, scheme: "dark" },
];
/** Browser checks have their own budget next to the 120 s of G1 (gates.yaml#G1.browser.time_budget_s). */
export const G1_BROWSER_TIME_BUDGET_MS = 300_000;
/** One scenario run (one cell of the matrix). */
export const GOAL_RUN_TIMEOUT_MS = 30_000;
const SETTLE_MS = 5_000;
/** Horizontal overflow tolerated (sub-pixel rounding). */
const OVERFLOW_TOLERANCE_PX = 1;

const HOP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "expect",
  "accept-encoding",
]);
const HOP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

const def = (id: string): CheckDef => CHECK_BY_ID.get(id) as CheckDef;
const schemeRu = (s: ColorScheme) => (s === "dark" ? "тёмная тема" : "светлая тема");
const where = (v: GoalViewport, s: ColorScheme) => `${v.width} px, ${schemeRu(s)}`;

export interface BrowserCheckInput {
  env: G1Env;
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  seed: Seed;
  /** Loads a fresh copy of the seed and signs its users in again (a reset empties the sessions too). */
  reset: () => Promise<Map<string, Actor[]>>;
  browser: Browser;
  /** Goal scenarios of the plan (compilePlan().scenarios); undefined — a system without a plan: G1-MOBILE-01 only. */
  scenarios?: readonly GoalScenarioInput[];
  /** Programs over the built-in GOAL_PROGRAMS (tests, modules in review). */
  programs?: Readonly<Record<string, GoalProgram>>;
  /** Cells of the scenario matrix (default GOAL_MATRIX). */
  matrix?: readonly { viewport: GoalViewport; scheme: ColorScheme }[];
  now: Date;
  /** Milliseconds left of the browser budget. */
  timeLeft: () => number;
  /** Screenshot of every page at 390 px (eval report grid, tests). */
  onScreenshot?: (s: { route: string; role: string; png: Uint8Array }) => void;
}

/** Answers every request of the browser context with the runtime handle (only the system's origin; no event stream). */
async function routeToRuntime(context: BrowserContext, env: G1Env): Promise<void> {
  await context.route("**/*", async (route) => {
    const req = route.request();
    try {
      const url = new URL(req.url());
      if (url.origin !== env.origin) return await route.abort("blockedbyclient");
      // The SSE stream never ends: the page works without live updates, the network settles. Not 2xx: an empty
      // successful stream makes the SDK resync (refetch every list) and reconnect every 500 ms; a refusal backs off.
      if (url.pathname === "/api/events" || url.pathname.startsWith("/api/events/"))
        return await route.fulfill({ status: 503, body: "" });
      // The runtime routes by Host (runtime.yaml#routing); a Request built in Node does not carry it by itself.
      const headers = new Headers({ host: url.host });
      for (const [k, v] of Object.entries(await req.allHeaders()))
        if (!HOP_REQUEST.has(k) && !k.startsWith(":")) headers.set(k, v);
      const method = req.method();
      const body = method === "GET" || method === "HEAD" ? undefined : (req.postDataBuffer() ?? undefined);
      const res = await env.runtime.fetch(
        new Request(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) }),
      );
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!HOP_RESPONSE.has(k)) out[k] = v;
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies.join("\n");
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch {
      // The context was closed while the runtime answered, or the runtime failed: the page sees a network error.
      await route.abort("failed").catch(() => {});
    }
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
  // React commits after the last response; one frame is enough for the DOM to reflect it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null)))).catch(() => {});
}

/** A browser context of the system at a viewport and color scheme, signed in as the actor (cookie of G1Env.login). */
async function openContext(
  browser: Browser,
  env: G1Env,
  viewport: GoalViewport,
  scheme: ColorScheme,
  actor: Actor,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  await routeToRuntime(context, env);
  if (actor.cookie) {
    const eq = actor.cookie.indexOf("=");
    await context.addCookies([
      { name: actor.cookie.slice(0, eq), value: actor.cookie.slice(eq + 1), url: env.origin },
    ]);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    if (errors.length < 5) errors.push(clip(String(e?.message ?? e), 200));
  });
  return { context, page, errors };
}

const OVERFLOW_PROBE = (tolerance: number) => {
  const vw = window.innerWidth;
  const over = document.documentElement.scrollWidth - vw;
  if (over <= tolerance) return { over: Math.max(0, over), culprits: [] as string[] };
  const culprits: string[] = [];
  const desc = (el: Element) => {
    const h = el as HTMLElement;
    const name =
      h.dataset?.wzComponent ??
      h.getAttribute("data-testid") ??
      `${el.tagName.toLowerCase()}${h.className && typeof h.className === "string" ? `.${h.className.split(" ")[0]}` : ""}`;
    return `${name} (${Math.round(el.getBoundingClientRect().width)} px): ${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}`;
  };
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + tolerance) continue;
    const parent = el.parentElement;
    // The element that sticks out, not its ancestors: its parent still fits.
    if (parent && parent !== document.body && parent.getBoundingClientRect().right > vw + tolerance) continue;
    culprits.push(desc(el));
    if (culprits.length >= 3) break;
  }
  return { over, culprits };
};

/** G1-MOBILE-01: every page × each of its roles at 390 px — no horizontal scroll. */
async function mobileFindings(
  input: BrowserCheckInput,
  actors: Map<string, Actor[]>,
): Promise<Finding[] | { error: string }> {
  const { env, spec, browser } = input;
  const findings: Finding[] = [];
  for (const [i, page] of (spec.pages ?? []).entries()) {
    for (const role of page.roles) {
      const actor = actors.get(role)?.[0];
      if (!actor) continue;
      if (input.timeLeft() <= 0) return { error: "превышено время проверок в браузере" };
      const path = await routePathFor(env, spec, input.files, input.seed, page.route, page.file, actor);
      const { context, page: p } = await openContext(browser, env, MOBILE_VIEWPORT, "light", actor);
      try {
        const res = await p.goto(`${env.origin}${path}`, { waitUntil: "load", timeout: 15_000 });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() ?? "нет ответа"}`);
        await settle(p);
        const r = await p.evaluate(OVERFLOW_PROBE, OVERFLOW_TOLERANCE_PX);
        if (input.onScreenshot)
          input.onScreenshot({ route: page.route, role, png: await p.screenshot({ fullPage: false }) });
        if (r.over > OVERFLOW_TOLERANCE_PX)
          findings.push({
            message_ru: `Страница «${page.title}» (${page.route}) для роли ${role} шире экрана телефона на ${Math.round(r.over)} px: появляется прокрутка вбок`,
            file: page.file,
            path: `/pages/${i}`,
            evidence: r.culprits.length
              ? `выходят за край: ${r.culprits.join("; ")}`
              : `ширина документа больше 390 px на ${Math.round(r.over)} px`,
            fixHint: `Проверьте ${page.file}: на 390 px элементы должны переноситься или сжиматься (без фиксированной ширины больше экрана)`,
          });
      } catch (e) {
        findings.push({
          message_ru: `Страница «${page.title}» (${page.route}) для роли ${role} не открылась в браузере на 390 px`,
          file: page.file,
          path: `/pages/${i}`,
          evidence: clip(String((e as Error)?.message ?? e), 300),
        });
      } finally {
        await context.close().catch(() => {});
      }
    }
  }
  return findings;
}

const SYNTHETIC = {
  email: (m: string) => `goal.${m}@example.test`,
  /** A Russian mobile number of the run: +7 999 and seven digits of the marker. */
  phone: (m: string) =>
    `999${String(Number.parseInt(m.replace(/[^0-9a-f]/g, "").slice(-6) || "0", 16) % 10_000_000).padStart(7, "0")}`,
  url: "https://example.test",
  int: "2",
  decimal: "1500",
};

/** Fills a form in the page; returns label → value. Runs in the browser (no closure over Node values). */
const FILL_PROBE = (arg: { within: string | null; marker: string }) => {
  const scope = arg.within ? document.querySelector(arg.within) : document;
  const form = scope?.querySelector("form");
  if (!form)
    return {
      error: "form" as const,
      fields: [] as { id: string; kind: string; label: string; name: string; options?: string[] }[],
    };
  const fields: { id: string; kind: string; label: string; name: string; options?: string[] }[] = [];
  let n = 0;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const labelOf = (el: Element) => {
    const id = el.getAttribute("id");
    const lab = id ? form.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
    return (lab?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60);
  };
  const radios = new Set<string>();
  for (const el of form.querySelectorAll("input, textarea, select")) {
    const h = el as HTMLInputElement;
    if (
      h.disabled ||
      h.readOnly ||
      h.type === "hidden" ||
      h.type === "file" ||
      h.type === "submit" ||
      h.type === "button"
    )
      continue;
    if (!visible(el) && h.type !== "checkbox" && h.type !== "radio") continue;
    const tag = `goal-${n++}`;
    el.setAttribute("data-goal-field", tag);
    let kind: string = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "text" : h.type;
    if (kind === "text" && el.tagName === "INPUT")
      kind = h.inputMode === "numeric" ? "int" : h.inputMode === "decimal" ? "decimal" : "text";
    if (kind === "radio") {
      if (radios.has(h.name)) continue;
      radios.add(h.name);
    }
    const options =
      el.tagName === "SELECT"
        ? [...(el as HTMLSelectElement).options].filter((o) => o.value !== "").map((o) => o.value)
        : undefined;
    // ui-kit marks a field wz-field-<name>: the spec's bounds of a number field apply by that name.
    const name = el.closest('[data-testid^="wz-field-"]')?.getAttribute("data-testid")?.slice(9) ?? "";
    fields.push({ id: tag, kind, label: labelOf(el), name, ...(options ? { options } : {}) });
  }
  return { error: null, fields };
};

class Run implements GoalRun {
  page!: Page;
  private context: BrowserContext | null = null;
  private errors: string[] = [];
  private current = "начало сценария";
  private clock: Date;
  private readonly outboxStart: number;
  private actor: Actor;

  readonly contact: { readonly email: string; readonly phone: string };

  constructor(
    private readonly input: BrowserCheckInput,
    private readonly actors: Map<string, Actor[]>,
    readonly scenario: GoalScenarioInput,
    readonly viewport: GoalViewport,
    readonly scheme: ColorScheme,
    readonly marker: string,
  ) {
    this.clock = new Date(input.now);
    this.outboxStart = input.env.runtime.outbox().length;
    this.actor = input.env.anonymous();
    this.contact = {
      email: SYNTHETIC.email(marker.replace(/\W/g, "").toLowerCase()),
      phone: SYNTHETIC.phone(marker),
    };
  }

  get spec(): AppSpec {
    return this.input.spec;
  }

  get now(): Date {
    return new Date(this.clock);
  }

  get files(): ReadonlyMap<string, string> {
    return this.input.files;
  }

  get stepName(): string {
    return this.current;
  }

  get pageErrors(): string[] {
    return this.errors;
  }

  step(text: string): void {
    this.current = text;
  }

  fail(reason: string, evidence?: string): never {
    throw new GoalFailure(reason, evidence);
  }

  private roleActor(a: "owner" | "staff" | { role: string }): Actor | null {
    const spec = this.input.spec;
    const role =
      typeof a === "object"
        ? a.role
        : a === "owner"
          ? spec.roles.find((r) => r.isAdmin && r.access !== "public")?.name
          : spec.roles.find((r) => !r.isAdmin && r.access !== "public")?.name;
    return role ? (this.actors.get(role)?.[0] ?? null) : null;
  }

  actorId(a: "owner" | "staff" | { role: string }): string | null {
    return this.roleActor(a)?.id ?? null;
  }

  async as(a: "visitor" | "client" | "owner" | "staff" | { role: string }): Promise<void> {
    let actor: Actor | null;
    if (a === "visitor" || a === "client") actor = this.input.env.anonymous();
    else actor = this.roleActor(a);
    if (!actor)
      this.fail(
        `в системе нет пользователя для роли «${typeof a === "object" ? a.role : a === "owner" ? "владелец" : "сотрудник"}»`,
      );
    await this.close();
    this.actor = actor;
    const o = await openContext(this.input.browser, this.input.env, this.viewport, this.scheme, actor);
    this.context = o.context;
    this.page = o.page;
    this.errors = o.errors;
  }

  async newTab(): Promise<Page> {
    if (!this.context) await this.as("visitor");
    const page = await (this.context as BrowserContext).newPage();
    page.on("pageerror", (e) => {
      if (this.errors.length < 5) this.errors.push(clip(String(e?.message ?? e), 200));
    });
    return page;
  }

  useTab(page: Page): void {
    this.page = page;
  }

  async open(path: string): Promise<void> {
    if (!this.context) await this.as("visitor");
    const res = await this.page.goto(`${this.input.env.origin}${path}`, {
      waitUntil: "load",
      timeout: 15_000,
    });
    if (!res || res.status() >= 400)
      this.fail(`страница ${path} не открывается`, `HTTP ${res?.status() ?? "нет ответа"}`);
    await settle(this.page);
  }

  async fillForm(within?: string): Promise<FilledForm> {
    const r = await this.page.evaluate(FILL_PROBE, { within: within ?? null, marker: this.marker });
    if (r.error) {
      const scope = within ? this.page.locator(within).first() : this.page.locator("body");
      const seen = ((await scope.innerText({ timeout: 1_000 }).catch(() => "")) || "").replace(/\s+/g, " ");
      this.fail(
        within ? "на странице нет формы в нужном блоке" : "на странице нет формы",
        seen ? `в блоке: ${clip(seen, 300)}` : "блока нет на странице",
      );
    }
    const filled: FilledForm = {};
    const today = this.clock.toISOString().slice(0, 10);
    const typed: Record<string, string> = {
      email: this.contact.email,
      tel: this.contact.phone,
      url: SYNTHETIC.url,
      date: today,
      "datetime-local": `${today}T10:00`,
      time: "10:00",
      int: SYNTHETIC.int,
      decimal: SYNTHETIC.decimal,
      number: SYNTHETIC.decimal,
    };
    for (const f of r.fields) {
      const loc = this.page.locator(`[data-goal-field="${f.id}"]`);
      const key = f.label || f.id;
      if (f.kind === "checkbox" || f.kind === "radio") {
        await loc.check({ force: true });
        filled[key] = f.kind === "checkbox" ? "да" : "первый вариант";
      } else if (f.kind === "select") {
        const v = f.options?.[0];
        if (v === undefined) continue;
        await loc.selectOption(v);
        filled[key] = v;
      } else if (f.kind !== "search") {
        let value = typed[f.kind] ?? this.marker;
        if (f.kind === "int" || f.kind === "decimal" || f.kind === "number")
          value = this.inBounds(f.name, value);
        await loc.fill(value);
        filled[key] = value;
      }
    }
    return filled;
  }

  /** A synthetic number moved into the spec's min…max of number fields with this name. */
  private inBounds(name: string, value: string): string {
    let n = Number(value);
    for (const e of this.input.spec.entities)
      for (const f of e.fields) {
        if (f.name !== name) continue;
        if (typeof f.min === "number" && n < f.min) n = f.min;
        if (typeof f.max === "number" && n > f.max) n = f.max;
      }
    return String(n);
  }

  settle(): Promise<void> {
    return settle(this.page);
  }

  async submit(within?: string): Promise<void> {
    const form = this.page.locator(`${within ? `${within} ` : ""}form`).first();
    const button = form.locator('button[type="submit"], input[type="submit"]').first();
    if ((await button.count()) === 0) this.fail("у формы нет кнопки отправки");
    // The SDK validates first and sends the write a few ticks later: wait for the write itself (a form the client
    // rejects sends nothing — then the short wait ends and the page shows why).
    const write = this.page
      .waitForResponse(
        (r) => r.request().method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/"),
        {
          timeout: 3_000,
        },
      )
      .catch(() => null);
    await button.click();
    await write;
    await settle(this.page);
  }

  async expectText(text: string, opts: { within?: string; timeoutMs?: number } = {}): Promise<void> {
    const scope = opts.within ? this.page.locator(opts.within).first() : this.page.locator("body");
    const loc = scope.getByText(text, { exact: false }).first();
    try {
      await loc.waitFor({ state: "visible", timeout: opts.timeoutMs ?? 5_000 });
    } catch {
      const seen = clip(((await scope.innerText().catch(() => "")) || "").replace(/\s+/g, " "), 300);
      this.fail(`на экране нет текста «${text}»`, seen ? `на экране: ${seen}` : undefined);
    }
  }

  async expectNear(anchor: string, text: string): Promise<void> {
    // Lists load after the page settles: look again for up to 5 s.
    let found = "absent";
    for (const deadline = Date.now() + 5_000; ; ) {
      found = await this.page.evaluate(
        ([a, t]) => {
          const low = (s: string) => s.toLowerCase().replace(/ё/g, "е");
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.includes(a)) continue;
            let el: Element | null = n.parentElement;
            for (let k = 0; el && k < 8; k++, el = el.parentElement)
              if (low(el.textContent ?? "").includes(low(t))) return "near";
            return "alone";
          }
          return "absent";
        },
        [anchor, text] as const,
      );
      if (found === "near" || Date.now() > deadline) break;
      await this.page.waitForTimeout(200);
    }
    if (found === "absent") this.fail("запись не видна на экране");
    if (found === "alone") this.fail(`рядом с записью нет «${text}»`);
  }

  rows(entity: string): Promise<Record<string, unknown>[]> {
    return this.input.env.rows(entity);
  }

  async newRows(entity: string): Promise<Record<string, unknown>[]> {
    const seeded = new Set(this.seedRows(entity).map((r) => r.id));
    return (await this.rows(entity)).filter((r) => !seeded.has(r.id));
  }

  seedRows(entity: string): readonly Record<string, unknown>[] {
    return this.input.seed.rows[entity] ?? [];
  }

  userIds(actor: "owner" | "staff"): string[] {
    const roles = new Set(
      this.input.spec.roles
        .filter((r) => r.access !== "public" && (actor === "owner" ? r.isAdmin === true : r.isAdmin !== true))
        .map((r) => r.name),
    );
    return this.input.seed.users.filter((u) => roles.has(u.role)).map((u) => u.id);
  }

  async runJobs(): Promise<void> {
    const since = new Date(this.clock.getTime() - 60_000);
    const r = await this.input.env.runJobs(this.clock, since);
    if (!r) this.fail("в среде проверки нет обработчика фоновых задач");
    if (r.failed.length)
      this.fail(
        "фоновая задача системы завершилась ошибкой",
        r.failed
          .slice(0, 3)
          .map((f) => `${f.kind} ${f.name}: ${f.code}`)
          .join("; "),
      );
  }

  async advance(minutes: number): Promise<void> {
    this.clock = new Date(this.clock.getTime() + minutes * 60_000);
    await this.runJobs();
  }

  outbox(connector: "email" | "telegram"): GoalOutboxMessage[] {
    const names = new Set(
      (this.input.spec.integrations ?? []).filter((i) => i.connector === connector).map((i) => i.name),
    );
    return this.input.env.runtime
      .outbox()
      .slice(this.outboxStart)
      .filter((m) => names.has(m.integration));
  }

  serviceMessages(): GoalOutboxMessage[] {
    return this.input.env.runtime
      .outbox()
      .slice(this.outboxStart)
      .filter((m) => m.integration === "_platform" || m.integration === "_sms");
  }

  api(method: string, path: string, body?: unknown) {
    return this.input.env.request(this.actor, method, path, body);
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
  }
}

/** One scenario over the matrix: the first failing cell is reported. */
async function runScenarioCells(
  input: BrowserCheckInput,
  sc: GoalScenarioInput,
  program: GoalProgram,
): Promise<{ ok: true } | { ok: false; message: string; evidence?: string } | { timeout: true }> {
  for (const cell of input.matrix ?? GOAL_MATRIX) {
    if (input.timeLeft() <= 0) return { timeout: true };
    // Each cell on a fresh copy of the seed: a cell never sees the records of another.
    const actors = await input.reset();
    const run = new Run(
      input,
      actors,
      sc,
      cell.viewport,
      cell.scheme,
      `Проверка ${randomBytes(3).toString("hex")}`,
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        program(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new GoalFailure(`сценарий выполнялся дольше ${GOAL_RUN_TIMEOUT_MS / 1000} с`)),
            Math.min(GOAL_RUN_TIMEOUT_MS, Math.max(1, input.timeLeft())),
          );
        }),
      ]);
    } catch (e) {
      const reason =
        e instanceof GoalFailure
          ? e.message
          : `внутренняя ошибка проверки: ${String((e as Error)?.message ?? e)}`;
      const evidence = [
        e instanceof GoalFailure ? e.evidence : undefined,
        run.pageErrors.length ? `ошибки страницы: ${run.pageErrors.join(" | ")}` : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      return {
        ok: false,
        message: `Сценарий цели «${sc.title}» не проходит (${where(cell.viewport, cell.scheme)}): ${run.stepName} — ${reason}`,
        ...(evidence ? { evidence } : {}),
      };
    } finally {
      clearTimeout(timer);
      await run.close();
    }
  }
  return { ok: true };
}

/** G1-GOAL-<id> and G1-MOBILE-01 entries of a G1 report. */
export async function runBrowserChecks(input: BrowserCheckInput): Promise<Check[]> {
  const out: Check[] = [];
  const goal = def("G1-GOAL");
  const programs = { ...GOAL_PROGRAMS, ...(input.programs ?? {}) };
  const cells = (input.matrix ?? GOAL_MATRIX).map((c) => where(c.viewport, c.scheme)).join(", ");
  for (const sc of input.scenarios ?? []) {
    const id = `G1-GOAL-${sc.id}`;
    const entry = (status: Check["status"], message: string, extra: Partial<Check> = {}): Check => ({
      id,
      status,
      severity: goal.severity,
      message_ru: clip(message, 300),
      ...(extra.evidence ? { evidence: clip(extra.evidence, 500) } : {}),
      ...(extra.fixHint ? { fixHint: clip(extra.fixHint, 300) } : {}),
    });
    const program = programs[sc.id];
    if (!program) {
      out.push(
        entry(
          "error",
          `Не удалось проверить: сценарий цели «${sc.title}» ещё не связан с проверкой в браузере`,
          {
            fixHint: `Добавьте программу сценария ${sc.id} в packages/gates/src/goals/programs/`,
          },
        ),
      );
      continue;
    }
    const r = await runScenarioCells(input, sc, program);
    if ("timeout" in r) out.push(entry("error", "Не удалось проверить: превышено время проверок в браузере"));
    else if (r.ok) out.push(entry("pass", `Сценарий цели «${sc.title}» проходит (${cells})`));
    else
      out.push(
        entry("fail", r.message, {
          ...(r.evidence ? { evidence: r.evidence } : {}),
          fixHint: `Модуль «${sc.module ?? "?"}»: сценарий ${sc.id} должен проходить на собранной системе без моделей`,
        }),
      );
  }
  if (input.timeLeft() <= 0) {
    out.push(
      ...toChecks(def("G1-MOBILE-01"), { kind: "error", reason_ru: "превышено время проверок в браузере" }),
    );
    return out;
  }
  const mobile = await mobileFindings(input, await input.reset());
  out.push(
    ...toChecks(
      def("G1-MOBILE-01"),
      "error" in mobile ? { kind: "error", reason_ru: mobile.error } : { kind: "findings", findings: mobile },
    ),
  );
  return out;
}

/** Entries when the browser checks could not run (no browser, failed setup). */
export function browserUnavailable(
  scenarios: readonly GoalScenarioInput[] | undefined,
  reason: string,
): Check[] {
  const goal = def("G1-GOAL");
  return [
    ...(scenarios ?? []).map(
      (sc): Check => ({
        id: `G1-GOAL-${sc.id}`,
        status: "error",
        severity: goal.severity,
        message_ru: clip(`Не удалось проверить сценарий цели «${sc.title}»: ${reason}`, 300),
      }),
    ),
    ...toChecks(def("G1-MOBILE-01"), { kind: "error", reason_ru: reason }),
  ];
}
