// Publish preconditions (workflows.yaml#workflows.publish.preconditions) and GET /systems/:id publishBlockers.
import type { AppSpec } from "@wizard/appspec";
import type { Selectable } from "kysely";
import type { Billing } from "../billing/ledger.js";
import { activeCard } from "../billing/payments.js";
import { planOf } from "../billing/plans.js";
import type { Db } from "../db/index.js";
import type { SystemsTable } from "../db/types.js";
import type { ErrorCode } from "../errors.js";
import type { AuthUser } from "../http/auth.js";
import { ACTIVE_STATUSES } from "../runs/queue.js";
import { loadRevision } from "../services/revisions.js";
import { isPublishable } from "./workflows.js";

/**
 * billing.yaml#plans prod_systems: other systems of the org that are in prod or have a publish run in flight (so
 * parallel first publications cannot both pass under the org lock). The system itself never counts.
 */
export async function prodSystemsCount(q: Db, orgId: string, exceptSystemId: string): Promise<number> {
  const row = await q
    .selectFrom("platform.systems as s")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("s.org_id", "=", orgId)
    .where("s.deleted_at", "is", null)
    .where("s.id", "!=", exceptSystemId)
    .where((eb) =>
      eb.or([
        eb("s.prod_revision", "is not", null),
        eb.exists(
          eb
            .selectFrom("platform.runs as r")
            .select("r.id")
            .whereRef("r.system_id", "=", "s.id")
            .where("r.kind", "=", "publish")
            .where("r.status", "in", [...ACTIVE_STATUSES]),
        ),
      ]),
    )
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

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

/**
 * workflows.yaml#workflows.publish.preconditions «M2: привязана карта РФ» (billing.yaml#card_binding): a prod
 * publication needs an active payment_methods row of the org; exempt orgs (local stand) and M0/M1 do not.
 */
export async function cardBindingMissing(
  db: Db,
  orgId: string,
  o: { required: boolean; billing?: Billing },
): Promise<boolean> {
  if (!o.required || o.billing?.isExempt(orgId)) return false;
  return !(await activeCard(db, orgId));
}

export const BLOCKER_RU: Partial<Record<ErrorCode, string>> = {
  CARD_BINDING_REQUIRED: "Привяжите карту российского банка — это нужно для публикации",
  OPERATOR_NAME_REQUIRED: "Укажите оператора персональных данных (раздел «Персональные данные»)",
  OPERATOR_CONTACT_REQUIRED: "Укажите e-mail оператора персональных данных для обращений",
  PHONE_LOGIN_PLAN_REQUIRED: "Вход по телефону доступен на тарифах Старт и Бизнес",
  PLAN_LIMIT: "Лимит опубликованных систем тарифа",
};

/**
 * api.yaml getSystem.publishBlockers for the revision the owner would publish now: the latest draft revision when it
 * is publishable, else the preview. Empty — publishing is possible.
 */
export async function publishBlockers(
  db: Db,
  user: AuthUser,
  s: Selectable<SystemsTable>,
  billing?: Billing,
  cardRequired = false,
): Promise<ErrorCode[]> {
  const out: ErrorCode[] = [];
  if (user.orgs.get(s.org_id) !== "owner") out.push("NOT_OWNER");
  if (s.suspended_at) out.push("SYSTEM_SUSPENDED");
  if (await cardBindingMissing(db, s.org_id, { required: cardRequired, ...(billing ? { billing } : {}) }))
    out.push("CARD_BINDING_REQUIRED");
  let rev = s.draft_revision > 0 ? await loadRevision(db, s.id, s.draft_revision) : undefined;
  if (rev && !isPublishable(rev, s.draft_revision))
    rev = s.preview_revision !== null ? await loadRevision(db, s.id, s.preview_revision) : undefined;
  if (!rev || !isPublishable(rev, s.draft_revision)) return [...out, "GATES_FAILED"];
  const org = await db
    .selectFrom("platform.orgs")
    .select("plan")
    .where("id", "=", s.org_id)
    .executeTakeFirstOrThrow();
  out.push(...specPublishBlockers(rev.spec as unknown as AppSpec, org.plan));
  // prod_systems (billing.yaml#plans.enforcement): republishing a system already in prod is always allowed.
  if (
    s.prod_revision === null &&
    !billing?.isExempt(s.org_id) &&
    (await prodSystemsCount(db, s.org_id, s.id)) >= planOf(org.plan).limits.prod_systems
  )
    out.push("PLAN_LIMIT");
  return out;
}
