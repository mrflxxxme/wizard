// B2-34 acceptance: cabinets of client systems on the design system v2 in Chromium. For the matrix rows of «Заявки»,
// «Запись по слотам», «Воронка сделок», «Клиенты с историей» and «Сотрудники и роли» the compiled system passes G0 and G1
// without models, and every cabinet page of every login role at 390 and 1280 px in the light and dark themes has the
// cabinet look (warm base, brand colour), AA contrast of the visible text, touch targets ≥ 44 px on the phone and no
// sideways scroll. Screenshots go to test/artifacts/cabinet-*.png (CI artifact of the e2e job).
// WIZARD_CABINET_ROWS=all shoots every matrix row (default: the first row of each module).
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
  type GoalScenarioInput,
  runG0,
  runG1,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "../../ui-kit/test/a11y/checks.js";
import { type CompileSuccess, compilePlan, MODULES_WITH_CODE, matrixPlan } from "../src/index.js";
import { testRegistry } from "./fixtures.js";

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
const MODULES = ["leads", "booking", "deals", "client_card", "staff"] as const;
const ALL_ROWS = process.env.WIZARD_CABINET_ROWS === "all";
const registry = testRegistry();
const keyPrefix = `b234${randomBytes(3).toString("hex")}`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_cab_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-cabinets-test-"));
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

/** Cabinet pages of each login role: pages of the role without a public role and without route params. */
function cabinetPages(spec: AppSpec): { role: string; pages: { route: string; title: string }[] }[] {
  const pub = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  return spec.roles
    .filter((r) => r.access !== "public")
    .map((r) => ({
      role: r.name,
      pages: (spec.pages ?? [])
        .filter((p) => p.roles.includes(r.name) && !p.roles.some((x) => pub.has(x)) && !p.route.includes(":"))
        .map((p) => ({ route: p.route, title: p.title })),
    }))
    .filter((x) => x.pages.length > 0);
}

/** What the page shows about the look and a11y (runs in the browser after A11Y_SCRIPT). */
const PROBE = () => {
  const a = (window as unknown as { __a11y: A11yApi }).__a11y;
  const html = document.documentElement;
  const s = getComputedStyle(html);
  return {
    look: html.getAttribute("data-wz-look"),
    bg: s.getPropertyValue("--w-bg").trim(),
    cabBg: s.getPropertyValue("--w-cab-bg").trim(),
    accent: s.getPropertyValue("--w-accent").trim(),
    cabAccent: s.getPropertyValue("--w-cab-accent").trim(),
    styles: document.querySelectorAll("style").length,
    contrast: a.contrast(),
    labels: a.labels(),
    touch: a.touch(),
    overflow: a.overflow(),
  };
};

const slug = (s: string) => s.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-") || "home";

interface Shot {
  module: string;
  row: string;
  role: string;
  route: string;
  cell: string;
  look: string | null;
  problems: string[];
}

/** One scenario per role: every cabinet page of the role in each cell of the matrix, screenshots and probes. */
function shootRole(
  module: string,
  rowName: string,
  rowIdx: number,
  roleName: string,
  pages: { route: string }[],
  shots: Shot[],
): GoalProgram {
  return async (t) => {
    await t.as({ role: roleName });
    const cell = `${t.viewport.width}-${t.scheme}`;
    const shoot = async (route: string, state: string) => {
      // page.evaluate is not subject to the CSP of the system (an inline script tag would be refused).
      await t.page.evaluate(A11Y_SCRIPT);
      const r = await t.page.evaluate(PROBE);
      const file = `cabinet-${module}-r${rowIdx}-${roleName}-${slug(route)}${state}-${cell}.png`;
      writeFileSync(join(ARTIFACTS, file), await t.page.screenshot({ fullPage: true }));
      const problems = [
        ...(r.look === "cabinet" ? [] : [`нет вида кабинета (data-wz-look=${r.look})`]),
        ...(r.bg === r.cabBg ? [] : [`фон ${r.bg} вместо ${r.cabBg}`]),
        ...(r.accent === r.cabAccent ? [] : [`акцент ${r.accent} вместо ${r.cabAccent}`]),
        ...r.contrast.map((x) => `контраст: ${x}`),
        ...r.labels.map((x) => `подпись: ${x}`),
        ...r.overflow.map((x) => `прокрутка вбок: ${x}`),
        ...(t.viewport.width <= 390 ? r.touch.map((x) => `касание < 44 px: ${x}`) : []),
      ];
      shots.push({
        module,
        row: rowName,
        role: roleName,
        route: `${route}${state}`,
        cell,
        look: r.look,
        problems,
      });
    };
    let opened = false;
    for (const p of pages) {
      t.step(`открыть ${p.route}`);
      await t.open(p.route);
      await shoot(p.route, "");
      // The first table row of the role: its card, then the edit form (cards and forms of the cabinet).
      const row = t.page.locator('[data-testid^="wz-datatable-row"]').first();
      if (opened || !(await row.isVisible().catch(() => false))) continue;
      opened = true;
      t.step(`открыть карточку записи на ${p.route}`);
      await row.click();
      await t.page.getByTestId("wz-recordcard").first().waitFor({ timeout: 5_000 });
      await shoot(p.route, "-card");
      const edit = t.page.getByRole("button", { name: "Изменить" }).first();
      if (!(await edit.isVisible().catch(() => false))) continue;
      t.step(`открыть форму правки на ${p.route}`);
      await edit.click();
      await t.page.getByTestId("wz-recordform").first().waitFor({ timeout: 5_000 });
      await shoot(p.route, "-form");
    }
  };
}

const rows = MODULES.flatMap((id) => {
  const def = MODULES_WITH_CODE.find((d) => d.manifest.id === id);
  const matrix = def?.manifest.tests?.matrix ?? [];
  return (ALL_ROWS ? matrix : matrix.slice(0, 1)).map((row, i) => ({ id, row, i }));
});

describe.skipIf(!hasChromium)("cabinets on the design system v2 (B2-34)", () => {
  test("every module of the acceptance has a matrix row", () => {
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(MODULES));
  });

  for (const x of rows)
    test(`${x.id} — ${x.row.name}: G0, G1 and cabinets 390/1280 × light/dark`, async () => {
      const r = compilePlan(matrixPlan(registry, x.id, x.row), registry, { appName: "Пример" });
      if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
      const ok = r as CompileSuccess;
      const spec = ok.spec as AppSpec;
      const byRole = cabinetPages(spec);
      expect(byRole.length, "у системы есть кабинеты").toBeGreaterThan(0);
      const shots: Shot[] = [];
      const scenarios: GoalScenarioInput[] = byRole.map((b) => ({
        id: `B234-${x.id}-${b.role}`,
        module: x.id,
        goal: "visibility",
        title: `Кабинет роли ${b.role}`,
        steps: [],
        expect: [],
      }));
      const programs = Object.fromEntries(
        byRole.map((b) => [
          `B234-${x.id}-${b.role}`,
          shootRole(x.id, x.row.name, x.i, b.role, b.pages, shots),
        ]),
      );
      const ctx: GateContext = {
        spec,
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
        goalScenarios: scenarios,
      };
      expect(failed(await runG0(ctx)), "G0").toEqual([]);
      // The look of the cabinets in all four cells (G1 goal scenarios run in two since B2-28).
      const g1 = await runG1(ctx, { goals: { programs, matrix: GOAL_MATRIX_FULL } });
      expect(failed(g1), "G1").toEqual([]);
      const pagesCount = byRole.reduce((n, b) => n + b.pages.length, 0);
      expect(shots.filter((s) => !/-(card|form)$/.test(s.route))).toHaveLength(pagesCount * 4);
      const bad = shots
        .filter((s) => s.problems.length)
        .map((s) => `${s.role} ${s.route} ${s.cell}: ${s.problems.slice(0, 4).join("; ")}`);
      expect(bad).toEqual([]);
    }, 300_000);
});
