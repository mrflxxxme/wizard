// runtime.yaml#auth.role_assignment (в): the system owner from the platform gets the first isAdmin role at
// publication, so the owner can sign in to the published system by an e-mail code. Called by platform-api in the
// apply_migration transaction of a publish (in-process engine and the DBOS worker alike).
import { type AppSpec, quoteIdent, type Role } from "@wizard/appspec";
import type postgres from "postgres";
import { schemaName, systemRoleOf } from "../migrate.js";
import type { SystemEnv } from "../registry.js";
import { normalizeEmail } from "./otp.js";

/**
 * The owner's role: the first login role with isAdmin (spec order), preferring one that allows email_otp — the
 * platform knows the owner's e-mail only. null when the spec has no isAdmin login role.
 */
export function ownerAdminRole(spec: AppSpec): Role | null {
  const admins = (spec.roles ?? []).filter((r) => r.access === "login" && r.isAdmin === true);
  return admins.find((r) => (r.loginMethods ?? []).includes("email_otp")) ?? admins[0] ?? null;
}

export interface OwnerAdminInput {
  systemKey: string;
  env: SystemEnv;
  spec: AppSpec;
  /** E-mail of the owner's platform account (normalized like the e-mail OTP login). */
  email: string;
  displayName?: string | null;
}

export type OwnerAdminResult = "created" | "exists" | "no_admin_role" | "invalid_email";

/**
 * Idempotent: inserts the owner into app_<key>_<env>.users with ownerAdminRole unless a user with this e-mail
 * already exists (an existing user — whatever role or block state — is left untouched; one user, one role).
 * Runs inside the caller's transaction as the system DB role (FORCE RLS, L3-20), then resets the role (NONE).
 */
export async function assignOwnerAdmin(
  tx: postgres.TransactionSql,
  i: OwnerAdminInput,
): Promise<OwnerAdminResult> {
  const role = ownerAdminRole(i.spec);
  if (!role) return "no_admin_role";
  const email = normalizeEmail(i.email);
  if (!email) return "invalid_email";
  const users = `${quoteIdent(schemaName(i.systemKey, i.env))}.${quoteIdent("users")}`;
  await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRoleOf(i.systemKey, i.env))}`);
  const rows = await tx.unsafe(
    `insert into ${users} (role, display_name, email) values ($1, $2, $3)
     on conflict (email) do nothing returning id`,
    [role.name, i.displayName?.trim() || null, email],
  );
  // A failed insert aborts the caller's transaction anyway; on success the caller's role comes back.
  await tx.unsafe("SET LOCAL ROLE NONE");
  return rows.length > 0 ? "created" : "exists";
}
