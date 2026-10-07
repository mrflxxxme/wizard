// B2-41: the plan of the D76 brief mvp-01 (dental clinic: landing, catalog, leads, notify by e-mail and Telegram)
// through G0/G1/G2 as the platform runs them — one long-lived G1 runtime, and after each gate the platform drops the
// outbox messages of its systems (apps/platform-api executors.gates, B2-28). The probe failed SC-AC1 «Владелец узнаёт о
// новой заявке» when another gate finished in the middle of the scenario: the drop shifted the shared outbox and the
// scenario looked for its messages past the end of it.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import {
  type GateContext,
  type GateLevel,
  type GateReport,
  type RuntimeHandle,
  runGates,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";
import { blockers } from "./g1-runtime.js";

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const LEAD_SCENARIO = "Владелец узнаёт о новой заявке";

/** mvp-01 as the D76 plan approves it: no custom part, nothing out of scope. */
function mvp01Plan(): SystemPlan {
  const base = landingLeadsPlan();
  return {
    ...base,
    modules: [
      { id: "landing" },
      { id: "catalog" },
      { id: "leads", params: { form_fields: ["name", "phone", "comment"], contact: "any" } },
      { id: "notify", params: { channels: ["email", "telegram"] } },
    ],
    outOfScope: [],
    custom: [],
  };
}

/** Operator data the owner fills before the first publication (G2-PII-06), as the D76 driver does. */
const withOperator = (spec: AppSpec): AppSpec => ({
  ...spec,
  compliance: {
    ...spec.compliance,
    operatorName: "Тестовый оператор замера D76",
    operatorContact: "owner@example.test",
    operatorAddress: "Тестовые данные замера D76, не для публикации",
  },
});

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let sys: CompileSuccess;
const keyPrefix = `b241${randomBytes(3).toString("hex")}`;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 6, onnotice: () => {} });
  role = `wz_mod_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-mvp01-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
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
  const r = compilePlan(mvp01Plan(), testRegistry(), { appName: "Улыбка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  sys = r;
});

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * A gate as apps/platform-api runs it: the shared runtime behind a handle that remembers the loaded systems; after the
 * gate they are unloaded and their outbox messages dropped. `beforeJobs` runs before each job-runner pass.
 */
async function platformGate(
  level: GateLevel,
  o: { beforeJobs?: () => void; noOperator?: boolean } = {},
): Promise<GateReport> {
  const loaded: { slug: string; env: "draft" | "prod"; systemKey: string }[] = [];
  const handle: RuntimeHandle = {
    fetch: (req) => rt.fetch(req),
    loadSystem: async (input) => {
      loaded.push({ slug: input.slug ?? input.systemKey, env: input.env, systemKey: input.systemKey });
      return rt.loadSystem(input);
    },
    outbox: () => rt.outbox(),
    runJobs: (input) => {
      o.beforeJobs?.();
      return rt.runJobs(input);
    },
    env: rt.env,
  };
  const ctx: GateContext = {
    spec: level === "G2" && !o.noOperator ? withOperator(sys.spec) : sys.spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(sys.files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    slug: "ulybka",
    db,
    milestone: "M2",
    runtime: handle,
    runtimeRole: role,
  };
  try {
    return await runGates(level, ctx);
  } finally {
    for (const l of loaded) rt.unloadSystem(l);
    rt.dropOutbox(loaded.map((l) => l.systemKey));
  }
}

const leadCheck = (r: GateReport) => {
  const ac = sys.spec.acceptance?.find((a) => a.text.startsWith(LEAD_SCENARIO));
  return r.checks.find((c) => c.id === `SC-${ac?.id}`);
};

describe("mvp-01 (landing, catalog, leads, notify e-mail + Telegram) through G0/G1/G2", () => {
  test("the plan has the lead scenario with e-mail and Telegram", () => {
    const ac = sys.spec.acceptance?.find((a) => a.text.startsWith(LEAD_SCENARIO));
    expect(ac?.text).toContain("Telegram");
    expect(sys.spec.integrations?.map((i) => i.connector).sort()).toEqual(["email", "telegram"]);
  });

  // The deterministic form of the probe's failure: a parallel build's gate leaves its messages in the shared outbox
  // before ours starts and finishes (the platform drops them) while our scenario runs the job runner. SC-AC1 is the
  // only scenario of the plan, so the first job-runner pass is its runWorkflows step.
  test("SC-AC1 survives another gate's messages dropped in the middle of the scenario", async () => {
    const parallel = await gateLeavingOutbox();
    expect(parallel.length).toBeGreaterThan(0);
    let armed = true;
    const g1 = await platformGate("G1", {
      beforeJobs: () => {
        if (!armed) return;
        armed = false;
        rt.dropOutbox(parallel);
      },
    });
    expect(armed).toBe(false);
    expect(leadCheck(g1)?.status, JSON.stringify(leadCheck(g1))).toBe("pass");
    expect(blockers(g1), "G1").toEqual([]);
  }, 240_000);

  // The probe's G2-PII-06 on mvp-01: the G2 of the build has no owner data yet (B2-21: it blocks the publication, not
  // the build); the D76 driver fills it before publishing — which it skipped there because G1 had failed.
  test("G2 of the build without operator data fails only G2-PII-06", async () => {
    const g2 = await platformGate("G2", { noOperator: true });
    expect([...new Set(blockers(g2).map((b) => b.split(" ")[0]))]).toEqual(["G2-PII-06"]);
  }, 120_000);

  test("G0, G1 and G2 five times in a row, the platform dropping the outbox after each gate", async () => {
    for (let i = 0; i < 5; i++) {
      for (const level of ["G0", "G1", "G2"] as const) {
        const r = await platformGate(level);
        expect(blockers(r), `${level}, run ${i + 1}`).toEqual([]);
        if (level === "G1") expect(leadCheck(r)?.status, `run ${i + 1}`).toBe("pass");
      }
    }
  }, 600_000);

  test("two builds of the plan at once: G1 and G2 in parallel", async () => {
    const both = await Promise.all(
      [0, 1].map(async () => {
        const g1 = await platformGate("G1");
        const g2 = await platformGate("G2");
        return { g1, g2 };
      }),
    );
    for (const [i, { g1, g2 }] of both.entries()) {
      expect(blockers(g1), `G1 #${i + 1}`).toEqual([]);
      expect(leadCheck(g1)?.status, `G1 #${i + 1}`).toBe("pass");
      expect(blockers(g2), `G2 #${i + 1}`).toEqual([]);
    }
  }, 600_000);
});

/** G1 of a system whose messages stay in the outbox (its gate has not finished yet); returns its system keys. */
async function gateLeavingOutbox(): Promise<string[]> {
  const before = new Set(rt.outbox().map((m) => m.system));
  const ctx: GateContext = {
    spec: sys.spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(sys.files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M2",
    runtime: rt,
    runtimeRole: role,
  };
  await runGates("G1", ctx);
  return [...new Set(rt.outbox().map((m) => m.system))].filter(
    (s): s is string => typeof s === "string" && !before.has(s),
  );
}
