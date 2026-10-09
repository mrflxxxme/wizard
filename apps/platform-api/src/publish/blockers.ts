// Publish preconditions (workflows.yaml#workflows.publish.preconditions) and GET /systems/:id publishBlockers.
import type { AppSpec } from "@wizard/appspec";
import { packageApplies } from "@wizard/gates";
import type { Selectable } from "kysely";
import { innValid } from "../auth/region.js";
import type { Billing } from "../billing/ledger.js";
import { activeCard } from "../billing/payments.js";
import { phoneOtpAllowed, planOf } from "../billing/plans.js";
import { techreviewBlockersOf } from "../builds-v3/techreview-verdict.js";
import type { Db } from "../db/index.js";
import type { SystemsTable } from "../db/types.js";
import type { ErrorCode } from "../errors.js";
import type { AuthUser } from "../http/auth.js";
import { ACTIVE_STATUSES } from "../runs/queue.js";
import { loadRevision } from "../services/revisions.js";
import { founderReviewStatus, ORG_SUSPENDED_RU, orgSuspended, REVIEW_PENDING_RU } from "./moderation.js";
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

/**
 * Blockers that depend only on the revision's spec and the org plan (M1; M2 adds card binding and review). Operator
 * of personal data (security/compliance.yaml#system_package.operator, gates.yaml G2-PII-06): name, contact and, since
 * M2, address when the spec has pii fields; operatorInn, when set, must pass the INN-10/12 checksum.
 */
export function specPublishBlockers(spec: AppSpec, plan: string): ErrorCode[] {
  const out: ErrorCode[] = [];
  const c = spec.compliance;
  // The same rule as G2-PII-06 (pii fields or a role with login — its users' e-mails are ПДн too): otherwise the owner
  // is not asked for the operator and the publication stops at G2 (checkpoint v3-007, CRM v3-03, 2026-10-09).
  const hasPii = packageApplies(spec);
  if (hasPii && !c?.operatorName?.trim()) out.push("OPERATOR_NAME_REQUIRED");
  if (hasPii && !c?.operatorContact?.trim()) out.push("OPERATOR_CONTACT_REQUIRED");
  if (hasPii && !c?.operatorAddress?.trim()) out.push("OPERATOR_ADDRESS_REQUIRED");
  if (c?.operatorInn !== undefined && !innValid(c.operatorInn)) out.push("INN_INVALID");
  if (!phoneOtpAllowed(plan) && spec.roles.some((r) => r.loginMethods?.includes("phone_otp")))
    out.push("PHONE_LOGIN_PLAN_REQUIRED");
  return out;
}

/**
 * workflows.yaml#workflows.publish.preconditions «M2: привязана карта РФ» (billing.yaml#card_binding): a prod
 * publication needs an active payment_methods row of the org; exempt orgs (local stand), M0/M1 and pilot orgs
 * (billing.yaml#plans.pilot.prod_requires: the founder's invitation identifies the owner) do not.
 */
export async function cardBindingMissing(
  db: Db,
  orgId: string,
  o: { required: boolean; billing?: Billing },
): Promise<boolean> {
  if (!o.required || o.billing?.isExempt(orgId)) return false;
  const org = await db.selectFrom("platform.orgs").select("plan").where("id", "=", orgId).executeTakeFirst();
  if (org?.plan === "pilot") return false;
  return !(await activeCard(db, orgId));
}

/**
 * M2 (config.prodG2Required or config.founderReviewRequired): the revision is on founder review (G2-AF-08/G2-AF-09
 * at a publish attempt, abuse.yaml#scoring.effect; first publication or new personal-data fields, M2-09) that staff
 * has not approved — pending or rejected.
 */
export async function founderReviewBlocks(
  db: Db,
  systemId: string,
  revision: number,
  required: boolean,
): Promise<boolean> {
  if (!required) return false;
  const st = await founderReviewStatus(db, systemId, revision);
  return st === "pending" || st === "rejected";
}

export const BLOCKER_RU: Partial<Record<ErrorCode, string>> = {
  FOUNDER_REVIEW_PENDING: REVIEW_PENDING_RU,
  ORG_SUSPENDED: ORG_SUSPENDED_RU,
  CARD_BINDING_REQUIRED: "Привяжите карту российского банка — это нужно для публикации",
  OPERATOR_NAME_REQUIRED: "Укажите оператора персональных данных (раздел «Персональные данные»)",
  OPERATOR_CONTACT_REQUIRED: "Укажите e-mail оператора персональных данных для обращений",
  OPERATOR_ADDRESS_REQUIRED: "Укажите адрес оператора персональных данных — он нужен для политики обработки",
  INN_INVALID: "ИНН оператора указан с ошибкой — проверьте цифры",
  PHONE_LOGIN_PLAN_REQUIRED: "Вход по телефону доступен на тарифах Старт и Бизнес",
  PLAN_LIMIT: "Лимит опубликованных систем тарифа",
};

/** The revision the owner would publish now: the latest draft revision when it is publishable, else the preview. */
async function publishableRevision(db: Db, s: Selectable<SystemsTable>) {
  let rev = s.draft_revision > 0 ? await loadRevision(db, s.id, s.draft_revision) : undefined;
  if (rev && !isPublishable(rev, s.draft_revision))
    rev = s.preview_revision !== null ? await loadRevision(db, s.id, s.preview_revision) : undefined;
  return rev && isPublishable(rev, s.draft_revision) ? rev : undefined;
}

/**
 * V3-18 api.yaml getSystem.techreviewBlockers: what the techreview of the v3 build that left the revision to publish
 * found (its GATES_FAILED in words); empty — nothing of the techreview stops it.
 */
export async function techreviewBlockers(db: Db, s: Selectable<SystemsTable>): Promise<string[]> {
  const rev = await publishableRevision(db, s);
  return rev ? techreviewBlockersOf(db, s.id, rev.version) : [];
}

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
  reviewRequired = false,
): Promise<ErrorCode[]> {
  const out: ErrorCode[] = [];
  if (user.orgs.get(s.org_id) !== "owner") out.push("NOT_OWNER");
  if (s.suspended_at) out.push("SYSTEM_SUSPENDED");
  if (await orgSuspended(db, s.org_id)) out.push("ORG_SUSPENDED");
  if (await cardBindingMissing(db, s.org_id, { required: cardRequired, ...(billing ? { billing } : {}) }))
    out.push("CARD_BINDING_REQUIRED");
  const rev = await publishableRevision(db, s);
  if (!rev) return [...out, "GATES_FAILED"];
  // V3-15: the techreview of the v3 build that left this revision found blockers.
  if ((await techreviewBlockersOf(db, s.id, rev.version)).length) return [...out, "GATES_FAILED"];
  const org = await db
    .selectFrom("platform.orgs")
    .select("plan")
    .where("id", "=", s.org_id)
    .executeTakeFirstOrThrow();
  out.push(...specPublishBlockers(rev.spec as unknown as AppSpec, org.plan));
  if (await founderReviewBlocks(db, s.id, rev.version, reviewRequired)) out.push("FOUNDER_REVIEW_PENDING");
  // prod_systems (billing.yaml#plans.enforcement): republishing a system already in prod is always allowed.
  if (
    s.prod_revision === null &&
    !billing?.isExempt(s.org_id) &&
    (await prodSystemsCount(db, s.org_id, s.id)) >= planOf(org.plan).limits.prod_systems
  )
    out.push("PLAN_LIMIT");
  return out;
}
