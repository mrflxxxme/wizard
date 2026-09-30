// Publish preconditions (workflows.yaml#workflows.publish.preconditions) and GET /systems/:id publishBlockers.
import type { AppSpec } from "@wizard/appspec";
import type { Selectable } from "kysely";
import type { Db } from "../db/index.js";
import type { SystemsTable } from "../db/types.js";
import type { ErrorCode } from "../errors.js";
import type { AuthUser } from "../http/auth.js";
import { loadRevision } from "../services/revisions.js";
import { isPublishable } from "./workflows.js";

/** Blockers that depend only on the revision's spec and the org plan (M1; M2 adds card binding and review). */
export function specPublishBlockers(spec: AppSpec, plan: string): ErrorCode[] {
  const out: ErrorCode[] = [];
  const hasPii = spec.entities.some((e) => e.fields.some((f) => (f.pii ?? "none") !== "none"));
  if (hasPii && !spec.compliance?.operatorName?.trim()) out.push("OPERATOR_NAME_REQUIRED");
  if (hasPii && !spec.compliance?.operatorContact?.trim()) out.push("OPERATOR_CONTACT_REQUIRED");
  if (plan === "free" && spec.roles.some((r) => r.loginMethods?.includes("phone_otp")))
    out.push("PHONE_LOGIN_PLAN_REQUIRED");
  return out;
}

export const BLOCKER_RU: Partial<Record<ErrorCode, string>> = {
  OPERATOR_NAME_REQUIRED: "Укажите оператора персональных данных (раздел «Персональные данные»)",
  OPERATOR_CONTACT_REQUIRED: "Укажите e-mail оператора персональных данных для обращений",
  PHONE_LOGIN_PLAN_REQUIRED: "Вход по телефону доступен на тарифах Старт и Бизнес",
};

/**
 * api.yaml getSystem.publishBlockers for the revision the owner would publish now: the latest draft revision when it
 * is publishable, else the preview. Empty — publishing is possible.
 */
export async function publishBlockers(
  db: Db,
  user: AuthUser,
  s: Selectable<SystemsTable>,
): Promise<ErrorCode[]> {
  const out: ErrorCode[] = [];
  if (user.orgs.get(s.org_id) !== "owner") out.push("NOT_OWNER");
  if (s.suspended_at) out.push("SYSTEM_SUSPENDED");
  let rev = s.draft_revision > 0 ? await loadRevision(db, s.id, s.draft_revision) : undefined;
  if (rev && !isPublishable(rev, s.draft_revision))
    rev = s.preview_revision !== null ? await loadRevision(db, s.id, s.preview_revision) : undefined;
  if (!rev || !isPublishable(rev, s.draft_revision)) return [...out, "GATES_FAILED"];
  const org = await db
    .selectFrom("platform.orgs")
    .select("plan")
    .where("id", "=", s.org_id)
    .executeTakeFirstOrThrow();
  return [...out, ...specPublishBlockers(rev.spec as unknown as AppSpec, org.plan)];
}
