// RoleSpec (ui-kit.yaml#data_binding.role_spec, runtime.yaml#service_endpoints.role_spec) and `can`.
import type { AppSpec, Entity, Field, Page, Permission, PermissionOp, Role, Theme } from "@wizard/appspec";

export type LoginMethod = "phone_otp" | "email_otp" | "telegram";

export type RoleSpecCompliance = {
  consentText?: string;
  policyPage?: string;
  policyVersion?: string;
  consentTextHash?: string;
};

export interface RoleSpec {
  app: { name: string; description?: string };
  /** Current role (public role for guests); null when the system has no public role and nobody is logged in. */
  role: string | null;
  /** Names and labels of all roles (menu label, login targets); no permissions. */
  roles: Pick<Role, "name" | "label" | "access" | "isAdmin" | "selfSignup">[];
  /** Entities with the role's hiddenFields removed. */
  entities: Entity[];
  /** Permissions of the current role only. */
  permissions: Permission[];
  /** Pages with roles ∋ role. */
  pages: Page[];
  theme?: Theme;
  compliance?: RoleSpecCompliance;
  /** Union of loginMethods of access=login roles, already filtered by plan features. */
  loginMethods: LoginMethod[];
  /** Draft on a Free org: phone_otp is shown with the plan note (F4). */
  phoneOtpPlanNote?: boolean;
}

export type RoleSpecOptions = {
  /** registry.features.phoneOtp; false removes phone_otp (default true). */
  phoneOtp?: boolean;
  phoneOtpPlanNote?: boolean;
  policyVersion?: string;
  consentTextHash?: string;
};

/** Projection of AppSpec for one role; `role` null/undefined → public role (guest). */
export function toRoleSpec(spec: AppSpec, role?: string | null, opts: RoleSpecOptions = {}): RoleSpec {
  const current = role ?? spec.roles.find((r) => r.access === "public")?.name ?? null;
  const permissions = spec.permissions.filter((p) => p.role === current);
  const hidden = new Map(permissions.map((p) => [p.entity, new Set(p.hiddenFields ?? [])]));
  const entities = spec.entities.map((e) => ({
    ...e,
    fields: e.fields.filter((f) => !hidden.get(e.name)?.has(f.name)),
  }));
  const methods = new Set<LoginMethod>();
  for (const r of spec.roles) if (r.access === "login") for (const m of r.loginMethods ?? []) methods.add(m);
  if (opts.phoneOtp === false) methods.delete("phone_otp");
  const order: LoginMethod[] = ["email_otp", "phone_otp", "telegram"];
  return {
    app: { name: spec.app.name, ...(spec.app.description ? { description: spec.app.description } : {}) },
    role: current,
    roles: spec.roles.map((r) => ({
      name: r.name,
      label: r.label,
      access: r.access,
      ...(r.isAdmin ? { isAdmin: true } : {}),
      ...(r.selfSignup ? { selfSignup: true } : {}),
    })),
    entities,
    permissions,
    pages: (spec.pages ?? []).filter((p) => current !== null && p.roles.includes(current)),
    ...(spec.theme ? { theme: spec.theme } : {}),
    compliance: {
      ...(spec.compliance?.consentText ? { consentText: spec.compliance.consentText } : {}),
      ...(spec.compliance?.policyPage ? { policyPage: spec.compliance.policyPage } : {}),
      ...(opts.policyVersion ? { policyVersion: opts.policyVersion } : {}),
      ...(opts.consentTextHash ? { consentTextHash: opts.consentTextHash } : {}),
    },
    loginMethods: order.filter((m) => methods.has(m)),
    ...(opts.phoneOtpPlanNote ? { phoneOtpPlanNote: true } : {}),
  };
}

export function entityOf(spec: RoleSpec, entity: string): Entity | undefined {
  return spec.entities.find((e) => e.name === entity);
}

export function fieldOf(spec: RoleSpec, entity: string, field: string): Field | undefined {
  return entityOf(spec, entity)?.fields.find((f) => f.name === field);
}

export function permissionOf(spec: RoleSpec, entity: string): Permission | undefined {
  return spec.permissions.find((p) => p.entity === entity && p.role === spec.role);
}

/** can(op, entity, field?) from RoleSpec; the server stays the source of truth (403 → error state). */
export function can(spec: RoleSpec, op: PermissionOp, entity: string, field?: string): boolean {
  const p = permissionOf(spec, entity);
  if (!p?.ops.includes(op)) return false;
  if (field === undefined) return true;
  if (!fieldOf(spec, entity, field)) return false;
  if ((op === "update" || op === "create") && p.readonlyFields?.includes(field)) return false;
  return !(op === "update" && Object.hasOwn(p.rowFilter ?? {}, field));
}

export function readonlyFields(spec: RoleSpec, entity: string): Set<string> {
  return new Set(permissionOf(spec, entity)?.readonlyFields ?? []);
}

/** First string-typed visible field (search target, ref caption). */
export function titleField(spec: RoleSpec, entity: string): string | undefined {
  return entityOf(spec, entity)?.fields.find((f) => f.type === "string")?.name;
}

/** pii ≠ none; a file field without pii is basic (runtime.yaml#files.pii_and_retention). */
export function hasPii(f: Field | undefined): boolean {
  if (!f) return false;
  return (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none";
}

export function roleLabel(spec: RoleSpec, role: string | null | undefined): string {
  return spec.roles.find((r) => r.name === role)?.label ?? role ?? "";
}
