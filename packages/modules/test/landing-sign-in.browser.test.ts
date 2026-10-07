// B2-49 in Chromium: the landing of «CRM агентства недвижимости» (landing, client cards, deals, staff — nothing for the
// public to do) passes G0 and G1; at 390 and 1280 px in the light and dark themes it has one h1, «Войти» in the header
// and the hero, AA contrast, touch targets ≥ 44 px on the phone and no sideways scroll (G1-MOBILE-01); both buttons open
// the team's sign-in. Screenshots go to test/artifacts/landing-sign-in-*.png.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
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
import { type CompileSuccess, compilePlan, SIGN_IN_LABEL } from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { CRM_SECTIONS, crmLandingPlan } from "./fixtures-b249.js";

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
const keyPrefix = `b249${randomBytes(3).toString("hex")}`;
const HERO_TITLE = String(CRM_SECTIONS.find((s) => s.type === "hero")?.content.title);
const SIGN_IN_PATH = "/login";

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_lsi_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-landing-sign-in-test-"));
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

const PROBE = () => {
  const a = (window as unknown as { __a11y: A11yApi }).__a11y;
  const text = (sel: string) =>
    [...document.querySelectorAll(sel)].map((x) => (x.textContent ?? "").trim()).filter(Boolean);
  return {
    h1: text("h1"),
    headerCta: text('[data-testid="wz-header-cta"]'),
    heroPrimary: text('[data-testid="wz-hero-primary"]'),
    navEmpty: [...document.querySelectorAll('[data-testid="wz-header-nav"] a')].filter(
      (x) => !(x.textContent ?? "").trim(),
    ).length,
    contrast: a.contrast(),
    labels: a.labels(),
    touch: a.touch(),
    overflow: a.overflow(),
  };
};

function program(problems: string[]): GoalProgram {
  return async (t) => {
    await t.as("visitor");
    const cell = `${t.viewport.width}-${t.scheme}`;
    const add = (xs: string[], what: string) => problems.push(...xs.map((x) => `${cell} ${what}: ${x}`));
    t.step("Сотрудник открывает сайт");
    await t.open("/");
    await t.page.evaluate(A11Y_SCRIPT);
    const r = await t.page.evaluate(PROBE);
    writeFileSync(
      join(ARTIFACTS, `landing-sign-in-crm-${cell}.png`),
      await t.page.screenshot({ fullPage: true }),
    );
    if (r.h1.length !== 1 || r.h1[0] !== HERO_TITLE) add([JSON.stringify(r.h1)], "h1");
    if (r.headerCta.join() !== SIGN_IN_LABEL) add([JSON.stringify(r.headerCta)], "кнопка шапки");
    if (r.heroPrimary.join() !== SIGN_IN_LABEL) add([JSON.stringify(r.heroPrimary)], "кнопка первого экрана");
    if (r.navEmpty) add([String(r.navEmpty)], "пустые пункты меню");
    add(r.contrast, "контраст");
    add(r.labels, "подпись");
    add(r.overflow, "прокрутка вбок");
    if (t.viewport.width <= 390) add(r.touch, "касание < 44 px");
    for (const id of ["wz-hero-primary", "wz-header-cta"]) {
      t.step(`«${SIGN_IN_LABEL}» (${id}) открывает вход для команды`);
      await t.open("/");
      await t.page.getByTestId(id).first().click();
      await t.settle();
      const path = new URL(t.page.url()).pathname;
      if (path !== SIGN_IN_PATH) add([`${path} вместо ${SIGN_IN_PATH}`], id);
    }
  };
}

describe.skipIf(!hasChromium)("landing without public actions (B2-49)", () => {
  test("CRM landing: G0, G1 and «Войти» 390/1280 × light/dark", async () => {
    const r = compilePlan(crmLandingPlan(), registry, { appName: "Квартал" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    const ok = r as CompileSuccess;
    const problems: string[] = [];
    const id = "B249-crm";
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
      goalScenarios: [
        { id, module: "landing", goal: "attract", title: "Вход для команды", steps: [], expect: [] },
      ],
    };
    expect(failed(await runG0(ctx)), "G0").toEqual([]);
    const g1 = await runG1(ctx, {
      goals: { programs: { [id]: program(problems) }, matrix: GOAL_MATRIX_FULL },
    });
    expect(failed(g1), "G1").toEqual([]);
    expect(problems).toEqual([]);
  }, 300_000);
});
