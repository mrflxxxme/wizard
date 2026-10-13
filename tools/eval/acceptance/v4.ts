// V4 acceptance before the founder (docs/plans/2026-10-11-v4.md §5, D79 (10)): the whole v3 build on live models for
// three briefs (clinic, coffee house, beauty salon) on a platform of this process — the owner's way through the real
// routes (tools/eval/server/v3.mjs: the grill interview answered from the brief, the three first screens, «Собрать», the
// build of the harness v3, G0–G2), not the UI. Per build: the time to the three screens and to the ready system, ₽ by
// stage, the screenshots 390/1440, the critic's score, the gates — the report V4-04 of the run. Targets: screens ≤ 90 s,
// system ≤ 15 min, ≤ 300 ₽. Keys come from the environment (the v4-acceptance workflow's secrets); nothing is printed of
// them. Output: <out>/summary.md (the table), <out>/<brief>/{report.json,result.json,390.jpg,1440.jpg}.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAgentExecutors } from "../../../apps/platform-api/src/agents/executors.ts";
import { chromiumProvider } from "../../../apps/platform-api/src/agents/goal-browser.ts";
import { OutboxMailer } from "../../../apps/platform-api/src/auth/mailer.ts";
import { platformCritic } from "../../../apps/platform-api/src/builds-v3/critic.ts";
import { reportStorage } from "../../../apps/platform-api/src/builds-v3/report/index.ts";
import { loadBuildReport } from "../../../apps/platform-api/src/builds-v3/report/store.ts";
import type { BuildReport } from "../../../apps/platform-api/src/builds-v3/report/types.ts";
import { buildPipelineOrgsOf } from "../../../apps/platform-api/src/config.ts";
import { createTestDb, startApi, type TestApi } from "../../../apps/platform-api/test/helpers.ts";
import { closeExecutors } from "../../../apps/runtime/src/index.ts";
import { createRegistry, createRouter } from "../../../packages/llm/src/index.ts";
import { loadBriefs } from "../lib/briefs.mjs";
import { platformClient } from "../server/client.mjs";
import { evalCredits, evalIdentity, newEvalSession, newRunId, parseSeedOutput, seedSql } from "../server/seed.mjs";
import { runV3Eval } from "../server/v3.mjs";

/** The platform's origin as the cabinet sends it (the session's CSRF checks the Origin). */
const ORIGIN = "http://localhost:5173";

/** D79 (10): the targets of a build the founder is shown. */
export const V4_TARGETS = { screensSec: 90, systemMin: 15, rub: 300 };
/** The briefs of the acceptance: the clinic of the v3 set, the coffee house and the salon of this folder. */
export const V4_BRIEFS = [
  { id: "v3-02-dental-booking", dir: undefined },
  { id: "v3-13-coffee-house", dir: join(import.meta.dirname, "briefs") },
  { id: "v3-14-beauty-salon", dir: join(import.meta.dirname, "briefs") },
] as const;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout;
}

/** fetch into the in-process app; an aborted read cancels the response stream (SSE windows of the driver). */
function bridge(api: TestApi) {
  return async (url: string, init: RequestInit = {}) => {
    const res = await api.fetch(
      new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost:4000" } }),
    );
    const signal = init.signal;
    if (!signal || !res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel: () => reader.cancel(),
    });
    signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

interface Row {
  brief: string;
  status: string;
  screensSec: number | null;
  screensFromStartSec: number | null;
  systemMin: number | null;
  buildMin: number | null;
  rub: number;
  rubByCall: Record<string, number>;
  report: BuildReport | null;
  shots: string[];
  error: string | null;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const mark = (ok: boolean | null) => (ok === null ? "—" : ok ? "✅" : "❌");

/** The founder's table: one row per build, the targets marked. */
export function renderSummary(rows: readonly Row[], meta: { runUrl: string; shotsBase: string }): string {
  const out = [
    "# Приёмка V4: живая сборка v3 на трёх брифах",
    "",
    `Цели: три экрана ≤ ${V4_TARGETS.screensSec} с, система ≤ ${V4_TARGETS.systemMin} мин, ≤ ${V4_TARGETS.rub} ₽. Прогон: ${meta.runUrl}`,
    "",
    "| бриф | итог | три экрана, с | система, мин | ₽ | критик | гейты | снимки |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const rep = r.report;
    const gates = rep?.gates.length
      ? rep.gates.map((g) => `${g.level} ${g.passed ? "✅" : `❌ ${g.failed.map((f) => f.id).join(", ")}`}`).join("; ")
      : "—";
    const critic = rep?.critic?.scores.length ? `${rep.critic.scores.join(" → ")} (${rep.critic.stop ?? "—"})` : "—";
    const shots = r.shots.map((s) => `[${s.replace(/\.jpg$/, "")}](${meta.shotsBase}/${r.brief}/${s})`).join(" · ") || "—";
    out.push(
      `| ${r.brief} | ${r.status}${r.error ? `: ${r.error.slice(0, 80)}` : ""} | ${r.screensSec ?? "—"} ${mark(r.screensSec === null ? null : r.screensSec <= V4_TARGETS.screensSec)} | ${r.systemMin ?? "—"} ${mark(r.systemMin === null ? null : r.systemMin <= V4_TARGETS.systemMin)} | ${round(r.rub)} ${mark(r.rub <= V4_TARGETS.rub)} | ${critic} | ${gates} | ${shots} |`,
    );
  }
  out.push("", "## ₽ и минуты по этапам сборки (отчёт V4-04)", "");
  for (const r of rows) {
    out.push(`### ${r.brief}`, "");
    out.push(
      `Время: три экрана — ${r.screensSec ?? "—"} с (с начала разговора ${r.screensFromStartSec ?? "—"} с), сборка ${r.buildMin ?? "—"} мин, всего ${r.systemMin ?? "—"} мин.`,
    );
    out.push(
      `₽ по типам вызовов: ${Object.entries(r.rubByCall)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${round(v, 2)}`)
        .join(", ") || "—"}.`,
      "",
    );
    if (r.report?.stages.length) {
      out.push("| этап | статус | ₽ | мин |", "|---|---|---|---|");
      for (const s of r.report.stages) out.push(`| ${s.stage} | ${s.status} | ${round(s.rub, 2)} | ${round(s.minutes)} |`);
      out.push("");
    }
    // V4-18: the stubs the checks still see after the critic (its problems left) and any gate that failed on them.
    const stubs = [
      ...(r.report?.critic?.left ?? []).filter((p) => /^S0[1-4]$/.test(p.code)).map((p) => `${p.code} ${p.where}: ${p.message}`),
      ...(r.report?.gates ?? []).flatMap((g) => g.failed.filter((f) => /^S0[1-4]/.test(f.id)).map((f) => `${f.id} ${f.message}`)),
    ];
    out.push(`Заглушки S01–S04: ${stubs.length ? stubs.slice(0, 8).join("; ") : "не найдены"}.`);
    if (r.report?.techreview) out.push(`Техревью: ${r.report.techreview.status ?? "—"}, блокеров ${r.report.techreview.blockers.length}.`);
    if (r.report?.gaps.length) out.push(`Пробелы отчёта: ${r.report.gaps.join("; ")}.`);
    out.push("");
  }
  return out.join("\n");
}

export async function runAcceptance(o: { out: string; capRub: number; briefs?: readonly string[] }): Promise<Row[]> {
  const out = resolve(o.out);
  const artifactsDir = join(out, ".work", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const runid = newRunId();
  const { email } = evalIdentity(runid, undefined, "V3");
  const session = newEvalSession();
  const tdb = await createTestDb("v4acc", { migrator: true });
  const browser = chromiumProvider({ slots: 2 });
  let api: TestApi | undefined;
  try {
    api = await startApi(tdb.url, {
      config: {
        artifactsDir,
        authMode: "session",
        registration: "invite",
        prodG2Required: true,
        founderReviewRequired: true,
        unsafeLocalExec: true,
        runConcurrency: 2,
        buildPipeline: "modules",
        buildPipelineOrgs: buildPipelineOrgsOf("eval"),
        buildDefaultTier: "T1",
        // The build's goal scenarios and the report's screenshots in Chromium; the owner is «the founder» (V4-04 report).
        g1Browser: "chromium",
        founderEmail: email,
      },
      mailer: { send: async () => {} },
      creditsCronMs: 0,
      createRouter: (opts) =>
        createRouter({ ...opts, registry: opts.registry ?? createRegistry({ buildDefaultTier: "T1" }), mode: "live" }),
      executors: ({ pg, config }) =>
        createAgentExecutors({
          pg,
          config,
          research: null,
          v3: {
            enabled: true,
            hooks: { critic: platformCritic(browser) },
            mailer: new OutboxMailer(join(out, ".work", "outbox")),
          },
        }),
      publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
    });
    const seed = parseSeedOutput(
      psql(
        tdb.url,
        seedSql({
          runid,
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits: evalCredits(o.capRub),
          label: "V3",
        }),
      ),
    ) as { orgId: string; email: string };
    const raw = platformClient({ base: ORIGIN, session, fetch: bridge(api) });
    // The three first screens: POST /systems/:id/directions answers when the three directions are there.
    const screens = new Map<string, { at: number; sec: number }>();
    const client = {
      ...raw,
      async post(path: string, body: unknown) {
        const m = /^\/systems\/([^/]+)\/directions$/.exec(path);
        const t0 = Date.now();
        const res = await raw.post(path, body);
        if (m) screens.set(m[1] as string, { at: Date.now(), sec: round((Date.now() - t0) / 1000) });
        return res;
      },
    };
    const wanted = V4_BRIEFS.filter((b) => !o.briefs?.length || o.briefs.includes(b.id));
    const briefs = wanted.flatMap((b) => loadBriefs(b.id, b.dir));
    const doc = await runV3Eval({
      client,
      briefs,
      orgId: seed.orgId,
      ownerEmail: seed.email,
      runId: `v4-acceptance-${runid}`,
      maxCostRub: o.capRub,
      maxBriefRub: Math.min(o.capRub, 500),
      // One build at a time: each is timed as the owner sees it, not against the others.
      concurrency: 1,
      pollMs: 1000,
      log: (s: string) => console.log(s),
      g2: "skip",
    });
    const files = reportStorage({ artifactsDir });
    const rows: Row[] = [];
    {
      for (const r of doc.results as Record<string, any>[]) {
        const dir = join(out, r.id);
        mkdirSync(dir, { recursive: true });
        const runId: string | null = r.build?.runId ?? null;
        const report = runId ? await loadBuildReport(files, runId) : null;
        const shots: string[] = [];
        for (const s of report?.shots ?? []) {
          const f = await files.get(s.key).catch(() => null);
          if (!f) continue;
          const name = `${s.width}.${s.mime.includes("png") ? "png" : "jpg"}`;
          writeFileSync(join(dir, name), f.data);
          shots.push(name);
        }
        // The system id comes from the platform (a uuid), checked before it reaches the query.
        const byCall =
          typeof r.systemId === "string" && /^[0-9a-f-]{36}$/.test(r.systemId)
            ? psql(
                tdb.url,
                `select c.call_type || '|' || sum(c.cost_rub) from platform.llm_calls c
                  where c.system_id = '${r.systemId}' and c.billable group by c.call_type;`,
              )
                .split("\n")
                .filter(Boolean)
                .map((l) => l.split("|") as [string, string])
            : [];
        const rubByCall = Object.fromEntries(byCall.map(([k, v]) => [k, Number(v)]));
        const sc = r.systemId ? screens.get(r.systemId) : undefined;
        const row: Row = {
          brief: r.id,
          status: r.build?.status ?? r.status,
          screensSec: sc?.sec ?? null,
          screensFromStartSec: sc && r.startedAt ? round((sc.at - Date.parse(r.startedAt)) / 1000) : null,
          systemMin: typeof r.minutes === "number" ? round(r.minutes) : null,
          buildMin: typeof r.build?.minutes === "number" ? round(r.build.minutes) : null,
          rub: Object.values(rubByCall).reduce((a, b) => a + b, 0),
          rubByCall,
          report,
          shots,
          error: r.error ?? null,
        };
        writeFileSync(join(dir, "result.json"), `${JSON.stringify(r, null, 2)}\n`);
        if (report) writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        rows.push(row);
      }
    }
    return rows;
  } finally {
    await api?.dispose();
    await closeExecutors();
    await browser.close();
    await tdb.drop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const out = process.env.V4_ACC_OUT ?? ".acc-out";
  const rows = await runAcceptance({
    out,
    capRub: Number(process.env.V4_ACC_CAP_RUB) || 900,
    briefs: (process.env.V4_ACC_BRIEFS ?? "").split(",").filter(Boolean),
  });
  const md = renderSummary(rows, {
    runUrl: process.env.RUN_URL ?? "локально",
    shotsBase: process.env.V4_ACC_SHOTS_BASE ?? ".",
  });
  writeFileSync(join(out, "summary.md"), `${md}\n`);
  console.log(md);
  process.exit(0);
}
