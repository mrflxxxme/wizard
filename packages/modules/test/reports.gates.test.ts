// B2-17 acceptance through a real runtime: «Продажи» (a metric of every kind) + «Отчёты» compile, pass G0 and G1
// (the panel page renders on the seed), and the goalMetrics query computes every metric of the fixture rows for the
// week and the week before; the function metric's query answers by its contract; a visitor cannot call the query.
// Runtime setup as in gates.test.ts (packages/gates/test/g1-helpers.ts): own DB role, functions on, outbox connectors.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateContext, type GateReport, type QaCheck, runG1, runGates } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compilePlan } from "../src/index.js";
import { isoDate } from "../src/reports/lib/goalPanel.js";
import { testRegistry } from "./fixtures.js";
import { salesModule, salesPlan } from "./reports-fixtures.js";

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
const keyPrefix = `b217${randomBytes(3).toString("hex")}`;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_rep_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-reports-test-"));
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: qrKeyring }),
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
});

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

function ctx(spec: AppSpec, files: Record<string, string>, checks: QaCheck[]): GateContext {
  return {
    spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
    checks,
  };
}

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id} ${c.file ?? ""}: ${c.message_ru} ${c.evidence ?? ""}`);

const DAY = 1440;
const day = (n: number) => isoDate(Date.now() - n * 86_400_000);
const sale = (save: string, data: Record<string, unknown>) => ({ create: { entity: "sale", data, save } });

/** Six sales: four in the current week, two in the week before (by sold_at and sold_on). */
const scenario: QaCheck = {
  id: "SC-reports-1",
  kind: "scenario",
  level: "G1",
  scenario: {
    id: "SC-reports-1",
    title: "Панель цели считает метрики каждого вида по продажам",
    actors: { o: { role: "owner" } },
    seed: "none",
    steps: [
      { as: "o" },
      sale("a", { amount: 1000, client: "c1", status: "paid", sold_at: "$now-60m", sold_on: day(1) }),
      sale("b", { amount: 3000, client: "c1", status: "paid", sold_at: `$now-${DAY}m`, sold_on: day(3) }),
      sale("c", {
        amount: 500,
        client: "c2",
        status: "refunded",
        sold_at: `$now-${2 * DAY}m`,
        sold_on: day(3),
      }),
      sale("d", { amount: 2000, client: "c3", status: "paid", sold_at: `$now-${3 * DAY}m` }),
      sale("e", {
        amount: 4000,
        client: "c1",
        status: "paid",
        sold_at: `$now-${10 * DAY}m`,
        sold_on: day(10),
      }),
      sale("f", {
        amount: 100,
        client: "c4",
        status: "refunded",
        sold_at: `$now-${9 * DAY}m`,
        sold_on: day(9),
      }),
      { update: { entity: "sale", id: "$a.id", data: { client: "c1" } } },
      { callFn: { name: "goalMetrics", args: { period: "week" } } },
      {
        expect: {
          status: "ok",
          fields: {
            period: "week",
            metrics: [
              { id: "sales_paid", value: 3, previous: 1, capped: false },
              { id: "sales_refunds", value: 25, previous: 50, capped: false },
              { id: "sales_sum", value: 6000, previous: 4000, capped: false },
              { id: "sales_avg", value: 2000, previous: 4000, capped: false },
              { id: "sales_repeat", value: 33.3, previous: 0, capped: false },
              { id: "sales_days", value: 3, previous: 2, capped: false },
              { id: "sales_touched", value: 1, previous: 0, capped: false },
            ],
            reports: [
              {
                entity: "sale",
                total: 6,
                previous: 0,
                byStatus: [
                  { value: "paid", count: 4 },
                  { value: "refunded", count: 2 },
                ],
                capped: false,
              },
            ],
          },
        },
      },
      { callFn: { name: "fxSalesTarget", args: { period: "week" } } },
      { expect: { status: "ok", fields: { value: 40, previous: 50 } } },
      { as: "anon" },
      { callFn: { name: "goalMetrics", args: { period: "month" } } },
      { expect: { status: "denied" } },
    ],
  },
};

test("«Продажи» + «Отчёты»: G0, G1 with the panel rendered, every metric kind computed on the runtime", async () => {
  const r = compilePlan(salesPlan(), testRegistry([salesModule()]), { appName: "Посуда" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  const g0 = await runGates("G0", ctx(r.spec, r.files, []));
  expect(failed(g0), "G0").toEqual([]);
  const pages = new Map<string, string>();
  const g1 = await runG1(ctx(r.spec, r.files, [scenario]), {
    onRender: (x) => {
      if (x.html !== undefined) pages.set(`${x.file} ${x.role}`, x.html);
    },
  });
  expect(failed(g1), "G1").toEqual([]);
  expect(g1.checks.find((c) => c.id === "SC-reports-1")?.status).toBe("pass");
  expect(g1.checks.find((c) => c.id === "G1-RENDER-01")?.status).toBe("pass");
  // The panel on the seed: a group per plan goal under the client's wording, its tiles with the previous period.
  const panel = pages.get("ui/pages/ReportsGoals.tsx owner") ?? "";
  expect(panel).toContain("Цель: Покупатели возвращаются за новыми покупками");
  for (const label of [
    "Оплаченных продаж",
    "Доля возвратов",
    "Выручка",
    "Средний чек",
    "Повторные покупатели",
  ])
    expect(panel).toContain(label);
  expect(panel).toContain("Прошлый период");
  expect(panel).toContain("Скачать CSV");
}, 180_000);
