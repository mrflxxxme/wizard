// V3-15, platform part of the techreview of a v3 build (builder-v3.md §3 C6 stage 7, product.yaml D77_v3 (10)): the
// hook of the harness over the run's BuildHost. The deterministic part runs the real G0 on the system as the build has
// it — not committed yet — with the migration dry run in the shadow schema against the preview revision, and the static
// G2 (ПДн, secrets, Telegram, public role, antifraud) with the consent text of the legal template, the same as the gates
// stage; the dynamic G1/G2 (scenarios and the permission matrix through the runtime) stay the final gates stage, the
// latest G1 of this run is evidence for the module chains. The reviewer avoids the model families this run's builder
// answered on (platform.llm_calls). No gate events or reports: the techreview is a stage of its own; the publication
// gates run after it on the committed revision.
import {
  createTechreview,
  familyOf,
  G2_STATIC_CHECKS,
  type TechreviewDeps,
  type V3StageHook,
} from "@wizard/agents/builder";
import type { ModuleRegistry } from "@wizard/agents/planner";
import { type GateContext, type GateReport, runG2, runGates } from "@wizard/gates";
import type postgres from "postgres";
import { withConsentText } from "../agents/consent.js";
import type { Db } from "../db/index.js";
import type { BuildHost } from "../runs/types.js";
import { loadSpec } from "../services/revisions.js";

/** Call types of the v3 builder whose models the reviewer must not share (models.yaml#routes.techreview). */
export const BUILDER_CALL_TYPES = ["page_compose", "signature_section", "art_direction"] as const;

/** Families of the models this run's builder answered on. */
export async function runBuilderFamilies(pg: postgres.Sql, runId: string): Promise<string[]> {
  const rows = await pg<{ model_id: string }[]>`
    select distinct c.model_id from platform.llm_calls c
    where c.run_id = ${runId} and c.status = 'ok' and c.call_type in ${pg([...BUILDER_CALL_TYPES])}`;
  return [...new Set(rows.map((r) => familyOf(r.model_id)).filter((f): f is string => f !== null))].sort();
}

/** The latest G1 report of this run (the browser check of the last scenario): evidence for the module chains. */
export async function latestG1(pg: postgres.Sql, runId: string): Promise<GateReport[]> {
  const rows = await pg<{ report: GateReport }[]>`
    select r.report from platform.gate_reports r
    where r.run_id = ${runId} and r.level = 'G1'
    order by r.revision desc, r.created_at desc limit 1`;
  return rows.map((r) => r.report);
}

/** The techreview hook of a v3 build run (builds-v3/host.ts wires it into V3Host.hooks.techreview). */
export function platformTechreview(
  host: BuildHost,
  o: { pg: postgres.Sql; db: Db; registry?: ModuleRegistry; milestone?: string },
): V3StageHook {
  const systemId = host.run.systemId;
  const system = () =>
    o.db
      .selectFrom("platform.systems")
      .select(["id", "name", "schema_key", "preview_revision", "draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
  const deps: TechreviewDeps = {
    gates: async (level, s) => {
      const sys = await system();
      const ctx: GateContext = {
        spec: s.spec,
        prevSpec: sys.preview_revision !== null ? await loadSpec(o.db, sys, sys.preview_revision) : null,
        specVersion: sys.draft_revision,
        files: s.files,
        env: "draft",
        systemKey: sys.schema_key,
        db: o.pg,
        ...(o.milestone ? { milestone: o.milestone } : {}),
        ...(host.signal ? { signal: host.signal } : {}),
      };
      if (level === "G0") return runGates("G0", ctx);
      // compliance.consentText from the template (owner-only field, filled by the platform, never stored).
      return runG2({ ...ctx, spec: withConsentText(ctx.spec) }, { only: G2_STATIC_CHECKS });
    },
    evidence: () => latestG1(o.pg, host.run.id),
    builderFamilies: () => runBuilderFamilies(o.pg, host.run.id),
    request: async (r) => {
      // Once per system: a later build of the same system does not repeat the request.
      const [seen] = await o.pg<{ n: number }[]>`
        select count(*)::int as n from platform.development_requests d
        where d.system_id = ${systemId} and d.quote = ${r.quote_ru}`;
      if ((seen?.n ?? 0) > 0) return;
      await host.recordDevelopmentRequest({ category: "other", quote: r.quote_ru, offered: r.offered_ru });
    },
    ...(o.registry ? { registry: o.registry } : {}),
  };
  return createTechreview(deps);
}
