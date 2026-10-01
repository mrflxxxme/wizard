// Row → API shapes of specs/platform/api.yaml#/components/schemas.
import type { Selectable } from "kysely";
import type { MessagesTable, RevisionsTable, RunsTable, SystemsTable } from "../db/types.js";

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const credits = (milli: string | number | null | undefined): number | undefined =>
  milli === null || milli === undefined ? undefined : Number(milli) / 1000;

/** prodUrlOf given (publish/prod.ts prodUrl) → the system's prod URL when something is live. */
export function toSystem(s: Selectable<SystemsTable>, prodUrlOf?: (slug: string) => string) {
  return {
    id: s.id,
    orgId: s.org_id,
    slug: s.slug,
    name: s.name,
    stage: s.stage,
    draftRevision: s.draft_revision,
    previewRevision: s.preview_revision,
    prodRevision: s.prod_revision,
    prodUrl: s.prod_revision !== null && prodUrlOf !== undefined ? prodUrlOf(s.slug) : null,
    suspended: s.suspended_at !== null,
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
  };
}

export function toRun(r: Selectable<RunsTable>, lastEventSeq: number) {
  const c: Record<string, number> = {};
  const est = credits(r.credits_estimate_milli);
  const cap = credits(r.credits_cap_milli);
  if (est !== undefined) c.estimate = est;
  if (cap !== undefined) c.cap = cap;
  c.used = credits(r.credits_used_milli) ?? 0;
  return {
    id: r.id,
    systemId: r.system_id,
    kind: r.kind,
    ...(r.mode ? { mode: r.mode } : {}),
    status: r.status,
    currentStep: r.current_step,
    credits: c,
    baseRevision: r.base_revision,
    resultRevision: r.result_revision,
    failure: r.failure_code ? { code: r.failure_code, message_ru: r.failure_message_ru ?? "" } : null,
    lastEventSeq,
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export function toMessage(m: Selectable<MessagesTable>) {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    kind: m.kind,
    ...(m.text !== null ? { text: m.text } : {}),
    ...(m.payload !== null ? { payload: m.payload } : {}),
    runId: m.run_id,
    createdAt: iso(m.created_at),
  };
}

export function toRevisionSummary(
  r: Omit<Selectable<RevisionsTable>, "spec" | "ops"> & Partial<Selectable<RevisionsTable>>,
) {
  return {
    version: r.version,
    parentVersion: r.parent_version,
    author: r.author,
    authorUserId: r.author_user_id,
    runId: r.run_id,
    kind: r.kind,
    ...(r.summary_ru !== null ? { summary_ru: r.summary_ru } : {}),
    g0Passed: r.g0_passed,
    createdAt: iso(r.created_at),
  };
}
