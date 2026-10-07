// B2-41 dry run of the D76 measurement (docs/ops/eval-d76.md «Сухой прогон»): the whole path of the server measurement
// on a local stand, without network and without money — the eval account seeded by tools/eval/server/seed.mjs over
// psql, the driver (tools/eval/server/driver.mjs, threshold d76) over HTTP like the cabinet: brief → goal interview →
// plan approved as it is → build v2 → G0–G2 with the browser checks of G1 → first publication up to the founder's
// review → screenshots at 390 and 1280 px → collect over psql → the report (report.mjs) with the screenshot grid.
// Models answer from the recorded B2 scenarios (tools/fixtures/demo/b2/<name>.jsonl; the mvp briefs have no full
// recordings, only their design stage): each system replays the scenario whose brief it was created with.
// Platform settings as on the pilot (deploy.yaml#pilot.env + B2-41): WIZARD_BUILD_PIPELINE=modules, G1 in Chromium,
// M2 rules (G1 + G2 at publish), invite registration, payments off, founder review on.
// Run: `pnpm --filter @wizard/e2e exec tsx stand/d76-dry.ts [--scenarios barber,dental] [--out DIR]`
// (Postgres of `pnpm db:up`, psql on PATH, Playwright's Chromium). Exit 0 — the strict threshold passed on the dry run.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { createPlatformApi } from "@wizard/platform-api";
import { closeExecutors, DbRegistry, startRuntime } from "@wizard/runtime";
import postgres from "postgres";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HOST = "127.0.0.1";
const PORTS = { api: 4240, runtime: 4140, runtimeInternal: 4141 } as const;
const BASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
/** Recorded B2 scenarios with the whole path (interview, plan, texts, design; dental_custom also its custom code). */
export const DRY_SCENARIOS = ["barber", "dental", "dental_custom", "repair"] as const;
const TITLES: Record<string, string> = {
  barber: "Барбершоп: онлайн-запись к мастеру",
  dental: "Стоматология: заявки с сайта",
  dental_custom: "Стоматология с дописыванием кодом",
  repair: "Ремонт: заявки и этапы",
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** The recorded brief of a scenario: the user message of its first call (as the demo replay reads it). */
function recordedBrief(name: string): string {
  const first = readFileSync(join(ROOT, "tools/fixtures/demo/b2", `${name}.jsonl`), "utf8")
    .split("\n")
    .find((l) => l.trim() !== "");
  const line = JSON.parse(first ?? "{}") as {
    request?: { messages?: { role?: string; content?: unknown }[] };
  };
  const brief = line.request?.messages?.find((m) => m.role === "user")?.content;
  if (typeof brief !== "string" || !brief.trim()) throw new Error(`b2/${name}: нет брифа в записи`);
  return brief;
}

type Mod = Record<string, (...a: never[]) => unknown>;
const load = async (rel: string) => (await import(join(ROOT, rel))) as Mod;

function psql(url: string, input: string): string {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], {
    input,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`psql: ${String(r.stderr).split("\n")[0]}`);
  return String(r.stdout);
}

async function main(): Promise<number> {
  const names = (arg("scenarios") ?? DRY_SCENARIOS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names)
    if (!(DRY_SCENARIOS as readonly string[]).includes(n)) throw new Error(`сценарий ${n}?`);
  // B2-38 on the pilot: no stock keys yet — theme graphics instead of photos (deploy parameter stock_mode=off).
  process.env.WIZARD_STOCK_MODE ??= "off";
  const out = arg("out") ?? join(ROOT, ".data", "d76-dry");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = (m: string) => console.log(`[d76-dry] ${m}`);
  const briefs = names.map((n) => ({
    id: `b2-${n.replace(/_/g, "-")}`,
    title: TITLES[n] ?? n,
    class: "other",
    text: recordedBrief(n),
    free_answer: "Всё написал в описании",
  }));
  const byBrief = new Map(names.map((n, i) => [norm(briefs[i]?.text ?? ""), n]));

  // Scratch database next to the dev one (never the shared dev database), as the e2e stands do.
  const DB = `wz_d76_dry_${randomBytes(4).toString("hex")}`;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  for (const role of ["wizard_owner", "wizard_runtime"])
    await admin.unsafe(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
  await admin.unsafe(`GRANT CREATE ON DATABASE ${DB} TO wizard_owner`);
  const url = new URL(BASE_URL);
  url.pathname = `/${DB}`;
  const dbUrl = url.toString();
  const pg = postgres(dbUrl, { max: 4, onnotice: () => {} });
  const artifacts = join(out, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const internalToken = randomBytes(16).toString("hex");
  const origin = `http://${HOST}:${PORTS.api}`;

  /** The scenario of a system: the one whose recorded brief the system was created with. */
  const scenarioOf = new Map<string, Promise<string>>();
  const systemScenario = (systemId: string) => {
    let p = scenarioOf.get(systemId);
    if (!p) {
      p = pg<{ text: string | null }[]>`
        select m.text from platform.messages m
         where m.system_id = ${systemId} and m.role = 'user' order by m.seq limit 1`.then((rows) => {
        const n = byBrief.get(norm(rows[0]?.text ?? ""));
        if (!n) throw new Error(`система ${systemId}: бриф не из записанных сценариев`);
        return n;
      });
      scenarioOf.set(systemId, p);
    }
    return p;
  };
  const fixtureRouter = (opts: RouterOptions, name: string): Router =>
    createRouter({ ...opts, mode: "fixture", fixture: { suite: "demo", name: `b2/${name}` }, env: {} });

  const platform = await createPlatformApi({
    config: {
      dbUrl,
      artifactsDir: artifacts,
      authMode: "session",
      outboxDir: join(out, "outbox"),
      runtimePort: PORTS.runtime,
      platformOrigin: origin,
      internalToken,
      runtimeInternalUrl: `http://${HOST}:${PORTS.runtimeInternal}`,
      milestone: "M2",
      prodG2Required: true,
      unsafeLocalExec: true,
      registration: "invite",
      payments: false,
      founderReviewRequired: true,
      buildPipeline: "modules",
      g1Browser: "chromium",
      g1BrowserSlots: 1,
    },
    // One router per run: the fixture of the run's system, chosen on its first model call.
    createRouter: (opts) => {
      const shape = fixtureRouter(opts, names[0] ?? "dental");
      let inner: Promise<Router> | null = null;
      return {
        mode: shape.mode,
        registry: shape.registry,
        async route(input) {
          const systemId = input.ctx.systemId;
          if (!systemId) throw new Error("вызов модели без системы");
          inner ??= systemScenario(systemId).then((n) => fixtureRouter(opts, n));
          return (await inner).route(input);
        },
      };
    },
    log: (m, e) => console.error(`[d76-dry] platform-api: ${m}`, e ?? ""),
  });
  const apiServer = serve({ fetch: platform.fetch, port: PORTS.api, hostname: HOST });
  const runtime = await startRuntime({
    db: pg,
    registry: new DbRegistry(pg),
    artifactsRoot: artifacts,
    port: PORTS.runtime,
    internalPort: PORTS.runtimeInternal,
    env: {
      internalToken,
      platformInternalUrl: origin,
      systemsDomain: "localhost",
      devLogin: true,
      unsafeLocalExec: true,
      platformOrigin: origin,
    },
  });
  log(`стенд: api ${origin}, runtime :${PORTS.runtime}, БД ${DB}; сценарии: ${names.join(", ")}`);

  let code = 1;
  try {
    const seed = await load("tools/eval/server/seed.mjs");
    const driver = await load("tools/eval/server/driver.mjs");
    const report = await load("tools/eval/server/report.mjs");
    const shotsMod = await load("tools/eval/server/screenshots.mjs");
    const clientMod = await load("tools/eval/server/client.mjs");
    type Session = { token: string; csrf: string; tokenHash: string; csrfHash: string };
    const runid = (seed.newRunId as () => string)();
    const session = (seed.newEvalSession as () => Session)();
    // The eval account exactly as on the server: kind eval, pilot plan, founder review, credits for 300 ₽.
    const seedOut = psql(
      dbUrl,
      (seed.seedSql as (o: unknown) => string)({
        runid,
        domain: "borntobuild.ru",
        tokenHash: session.tokenHash,
        csrfHash: session.csrfHash,
        credits: (seed.evalCredits as (r: number) => number)(300),
        label: "D76",
      }),
    );
    const ids = (seed.parseSeedOutput as (s: string) => { orgId: string; email: string })(seedOut);
    log(`учётка замера ${ids.email}, организация ${ids.orgId}`);
    const client = (clientMod.platformClient as (o: unknown) => unknown)({ base: origin, session });
    const shots = (
      shotsMod.previewScreenshots as (o: unknown) => {
        screenshot: (r: unknown) => Promise<{ label: string; src: string }[]>;
        close: () => Promise<void>;
      }
    )({ client, dir: join(out, "shots"), log });
    type Doc = { results: { id: string; status: string }[]; stopped: string | null };
    let doc: Doc;
    try {
      doc = (await (driver.runEval as (o: unknown) => Promise<Doc>)({
        client,
        briefs,
        orgId: ids.orgId,
        ownerEmail: ids.email,
        runId: runid,
        threshold: "d76",
        maxCostRub: 300,
        concurrency: 2,
        pollMs: 500,
        log,
        screenshot: async (r: { id: string }) =>
          (await shots.screenshot(r)).map((s) => ({ ...s, src: `shots/${s.src.split("/").pop()}` })),
      })) as Doc;
    } finally {
      await shots.close();
    }
    const db = (seed.parseCollectOutput as (s: string) => unknown)(
      psql(dbUrl, (seed.collectSql as (o: unknown) => string)({ orgId: ids.orgId, b2Since: "2026-10-07" })),
    );
    psql(dbUrl, (seed.revokeSql as (o: unknown) => string)({ tokenHash: session.tokenHash }));
    const { text, summary } = (
      report.renderReport as (
        d: unknown,
        db: unknown,
        m: unknown,
      ) => { text: string; summary: { passed: boolean } }
    )(doc, db, {
      platform: `${origin} (сухой прогон, записанные ответы моделей)`,
      notes: [
        "Сухой прогон B2-41: ответы моделей записаны (tools/fixtures/demo/b2), расход — оценка записанного usage, денег не потрачено.",
      ],
    });
    writeFileSync(join(out, `d76-${runid}.md`), text);
    writeFileSync(join(out, `d76-${runid}.json`), `${JSON.stringify({ ...doc, db }, null, 2)}\n`);
    log(`отчёт: ${join(out, `d76-${runid}.md`)}`);
    console.log(text);
    code = summary.passed ? 0 : 1;
  } finally {
    await new Promise<void>((r) => apiServer.close(() => r()));
    await runtime.close().catch(() => {});
    await platform.close().catch(() => {});
    await Promise.resolve()
      .then(() => closeExecutors())
      .catch(() => {});
    await pg.end({ timeout: 5 }).catch(() => {});
    if (!process.env.WIZARD_D76_DRY_KEEP_DB)
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
    rmSync(artifacts, { recursive: true, force: true });
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`[d76-dry] ошибка: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(2);
  },
);
