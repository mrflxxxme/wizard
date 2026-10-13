// V4-04 (D79 (10), docs/plans/2026-10-11-v4.md §5.3): every v3 build leaves its report — screenshots 390/1440, gates and
// scenarios with the HTTP responses of their steps, the critic's score, ₽ and minutes by stage, the model calls; a
// founder's build also keeps the records of its model calls (V4-03). A failed founder build becomes an agent's task
// (apps/worker/src/report: an issue in the platform repository with the link to the report and the records).
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRegistry, RecordBook, type RouteInput, type RouteOutput, recordingRouter } from "@wizard/llm";
import { createFileStorage, type FileStorage } from "@wizard/runtime";
import type postgres from "postgres";
import type { GoalBrowserProvider } from "../../agents/goal-browser.js";
import type { BuildStore, HostRouteInput } from "../../runs/types.js";
import type { CriticInspectorOptions } from "../critic.js";
import { collectBuildReport } from "./collect.js";
import { httpRecorder } from "./http.js";
import { siteShots } from "./shots.js";
import { putReportFile, saveBuildReport } from "./store.js";
import type { BuildReport, ReportShot } from "./types.js";

export { collectBuildReport, failedChecks, stagesOf } from "./collect.js";
export { HTTP_PER_SCENARIO, httpRecorder } from "./http.js";
export { renderReportMd } from "./render.js";
export { reportRoutes } from "./routes.js";
export { loadBuildReport, REPORTS_SCHEMA, reportFile, reportKey, saveBuildReport } from "./store.js";
export type * from "./types.js";

/** The shared file storage of the platform, as the build executors make it (WIZARD_FILES_STORAGE, S3 on the cloud). */
export function reportStorage(
  config: { artifactsDir: string },
  env: Record<string, string | undefined> = process.env,
): FileStorage {
  return createFileStorage(env, { defaultDir: join(dirname(config.artifactsDir), "files") });
}

type HostRoute = (input: HostRouteInput) => Promise<RouteOutput>;

/** Whether run `runId` is the founder's: a staff org, or started by WIZARD_FOUNDER_EMAIL. */
export async function isFounderBuild(
  pg: postgres.Sql,
  runId: string,
  founderEmail?: string | null,
): Promise<boolean> {
  const [row] = await pg<{ kind: string; email: string | null }[]>`
    select o.kind, u.email from platform.runs r
    join platform.orgs o on o.id = r.org_id
    left join platform.users u on u.id = r.started_by
    where r.id = ${runId}`;
  if (!row) return false;
  return row.kind === "staff" || (!!founderEmail && row.email?.toLowerCase() === founderEmail.toLowerCase());
}

export interface BuildReportOptions {
  pg: postgres.Sql;
  runId: string;
  /** The shared file storage; null — the report is not kept (logged only). */
  files: FileStorage | null;
  store: BuildStore;
  /** The browser of the screenshots; null — the report says why there are none. */
  browser: GoalBrowserProvider | null;
  /** The founder's build: its model calls are recorded (V4-03). */
  founder: boolean;
  critic?: Omit<CriticInspectorOptions, "browser">;
  signal?: AbortSignal;
  log?: (msg: string, err: unknown) => void;
}

export interface BuildReportSession {
  /** The browser of the scenario checks: it records the HTTP responses of their steps. */
  provider(p: GoalBrowserProvider | null): GoalBrowserProvider | null;
  /** Runs the check of one brief scenario (its HTTP responses go to it). */
  scenario<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** The build's route: a founder build's calls become records. */
  route(route: HostRoute): HostRoute;
  /**
   * Collects and stores the report (never throws: a report never fails a build). `end` — how the build ended (the run's
   * row is finalized only after the executor returns).
   */
  finish(end?: BuildEnd): Promise<BuildReport | null>;
}

/** How the build ended. */
export interface BuildEnd {
  status: "succeeded" | "failed";
  code?: string | null;
  message?: string | null;
}

export function startBuildReport(o: BuildReportOptions): BuildReportSession {
  const http = httpRecorder();
  const recordsPath = join(tmpdir(), `wz-records-${o.runId}.jsonl`);
  let recorded = false;
  return {
    provider: (p) => http.provider(p),
    scenario: (id, fn) => http.scenario(id, fn),
    route(route) {
      if (!o.founder) return route;
      const registry = createRegistry();
      // The host adds the run's context itself; the recorder only needs a scope and the step.
      const inner = (ri: RouteInput): Promise<RouteOutput> => {
        const { ctx: _ctx, orgPolicy: _policy, signal: _signal, ...rest } = ri;
        return route(rest as HostRouteInput);
      };
      const rec = recordingRouter(
        { mode: "live", registry, route: inner },
        {
          book: new RecordBook(recordsPath),
          source: "build",
          onRecord: () => {
            recorded = true;
          },
        },
      );
      return (input) => rec.route({ ...input, ctx: { orgId: "build", systemId: o.runId } });
    },
    async finish(end) {
      const gaps: string[] = [];
      const shots: ReportShot[] = [];
      let records: string | null = null;
      try {
        if (!o.files) gaps.push("нет файлового хранилища — отчёт не сохранён");
        if (o.files && o.browser && (await o.browser.available())) {
          const r = await siteShots(o.store, o.browser, o.critic, o.signal).catch((e: unknown) => ({
            shots: [],
            error: String((e as Error)?.message ?? e).slice(0, 200),
          }));
          if (r.error) gaps.push(`снимки: ${r.error}`);
          for (const s of r.shots)
            shots.push({
              width: s.width,
              mime: s.mime,
              key: await putReportFile(o.files, `shot-${s.width}.jpg`, s.mime as "image/jpeg", s.data),
            });
        } else if (o.files) gaps.push("снимки: браузера нет");
        if (o.files && recorded) {
          records = await putReportFile(
            o.files,
            `records-${o.runId}.jsonl`,
            "application/json",
            new Uint8Array(readFileSync(recordsPath)),
          );
        }
        const collected = await collectBuildReport(o.pg, {
          runId: o.runId,
          http: http.responses(),
          shots,
          records,
          gaps,
        });
        const report: BuildReport | null =
          collected && end
            ? {
                ...collected,
                status: end.status,
                failure:
                  end.status === "failed" ? { code: end.code ?? null, message: end.message ?? null } : null,
              }
            : collected;
        if (report && o.files) await saveBuildReport(o.files, report);
        return report;
      } catch (e) {
        o.log?.("v4 build report failed", e);
        return null;
      } finally {
        rmSync(recordsPath, { force: true });
      }
    },
  };
}
