// B2-45 in Chromium: «/» of a system without the landing (the D76 measurement showed a name and one cabinet button) —
// the public home of a beauty salon, a meeting room with the visitor cabinet, «Заявки» with the catalog, and the staff
// sign-in page of a CRM pass G0 and G1; at 390 and 1280 px in the light and dark themes the page has its name as the
// only h1, its actions, AA contrast, touch targets ≥ 44 px on the phone and no sideways scroll (G1-MOBILE-01); the
// primary action opens its page. Screenshots go to test/artifacts/home-*.png.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import {
  type GateContext,
  type GateReport,
  GOAL_MATRIX_FULL,
  type GoalProgram,
  runG0,
  runG1,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "../../ui-kit/test/a11y/checks.js";
import { type CompileSuccess, compilePlan } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");
const registry = testRegistry();
const keyPrefix = `b245${randomBytes(3).toString("hex")}`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_home_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-home-test-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) }),
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  if (!hasChromium) return;
  await browser?.close();
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

const goalOf = (id: string) =>
  registry.modules.find((d) => d.manifest.id === id)?.manifest.goals[0] as SystemPlan["goals"][number]["id"];

function plan(niche: string, modules: SystemPlan["modules"]): SystemPlan {
  return {
    ...landingLeadsPlan(),
    niche,
    goals: [{ id: goalOf(modules[0]?.id ?? ""), statement: "Цель системы для проверки главной" }],
    modules,
    landing: undefined,
    outOfScope: [],
    custom: [],
  };
}

const CATALOG = { id: "catalog", params: { with_duration: true } };

interface Row {
  name: string;
  plan: SystemPlan;
  appName: string;
  /** Labels of links the home must show. */
  links: string[];
  /** Where the first «primary» action of the hero leads. */
  primary: string;
}

const ROWS: Row[] = [
  {
    name: "salon",
    plan: plan("салон красоты", [CATALOG, { id: "booking" }, { id: "notify" }, { id: "staff" }]),
    appName: "Студия «Лён»",
    links: ["Записаться", "Услуги и цены", "Войти в кабинет"],
    primary: "/booking",
  },
  {
    name: "room",
    plan: plan("переговорная в коворкинге", [
      CATALOG,
      { id: "booking" },
      { id: "notify" },
      { id: "visitor_cabinet", params: { show_bookings: true } },
    ]),
    appName: "Переговорная «Фокус»",
    links: ["Записаться", "Мои записи", "Войти в кабинет"],
    primary: "/booking",
  },
  {
    name: "leads",
    plan: plan("ремонт квартир", [{ id: "leads" }, { id: "notify" }, { id: "catalog" }]),
    appName: "Ремонт под ключ",
    links: ["Оставить заявку", "Услуги и цены", "Войти в кабинет"],
    primary: "/",
  },
  {
    name: "crm",
    plan: plan("агентство недвижимости", [
      { id: "deals" },
      { id: "client_card" },
      { id: "resources" },
      { id: "notify" },
    ]),
    appName: "Квартал",
    links: ["Войти"],
    primary: "/login",
  },
];

const PROBE = () => {
  const a = (window as unknown as { __a11y: A11yApi }).__a11y;
  return {
    h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
    links: [...document.querySelectorAll("a")].map((x) => (x.textContent ?? "").trim()),
    text: document.body.innerText,
    contrast: a.contrast(),
    labels: a.labels(),
    touch: a.touch(),
    overflow: a.overflow(),
  };
};

function homeProgram(row: Row, problems: string[]): GoalProgram {
  return async (t) => {
    await t.as("visitor");
    const cell = `${t.viewport.width}-${t.scheme}`;
    t.step("Посетитель открывает главную");
    await t.open("/");
    await t.page.evaluate(A11Y_SCRIPT);
    const r = await t.page.evaluate(PROBE);
    writeFileSync(
      join(ARTIFACTS, `home-${row.name}-${cell}.png`),
      await t.page.screenshot({ fullPage: true }),
    );
    const add = (xs: string[], what: string) =>
      problems.push(...xs.map((x) => `${row.name} ${cell} ${what}: ${x}`));
    if (r.h1.length !== 1 || r.h1[0] !== row.appName) add([JSON.stringify(r.h1)], "h1");
    if (r.text.includes("Открыть кабинет")) add(["«Открыть кабинет»"], "старая кнопка");
    add(
      row.links.filter((l) => !r.links.includes(l)),
      "нет ссылки",
    );
    add(r.contrast, "контраст");
    add(r.labels, "подпись");
    add(r.overflow, "прокрутка вбок");
    if (t.viewport.width <= 390) add(r.touch, "касание < 44 px");
    t.step("Главное действие открывает свою страницу");
    await t.page.getByTestId("wz-hero-primary").first().click();
    await t.settle();
    const path = new URL(t.page.url()).pathname;
    if (path !== row.primary) add([`${path} вместо ${row.primary}`], "главное действие");
  };
}

describe.skipIf(!hasChromium)("home page without the landing (B2-45)", () => {
  for (const row of ROWS)
    test(`${row.name}: G0, G1 and «/» 390/1280 × light/dark`, async () => {
      const r = compilePlan(row.plan, registry, { appName: row.appName });
      if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
      const ok = r as CompileSuccess;
      const problems: string[] = [];
      const id = `B245-${row.name}`;
      const ctx: GateContext = {
        spec: ok.spec as AppSpec,
        prevSpec: null,
        specVersion: 1,
        files: new Map(Object.entries(ok.files)),
        env: "draft",
        systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
        db,
        milestone: "M1",
        runtime: rt,
        runtimeRole: role,
        browser,
        goalScenarios: [{ id, module: "home", goal: "attract", title: "Главная", steps: [], expect: [] }],
      };
      expect(failed(await runG0(ctx)), "G0").toEqual([]);
      const g1 = await runG1(ctx, {
        goals: { programs: { [id]: homeProgram(row, problems) }, matrix: GOAL_MATRIX_FULL },
      });
      expect(failed(g1), "G1").toEqual([]);
      expect(problems).toEqual([]);
    }, 300_000);
});
