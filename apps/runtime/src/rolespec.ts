// RoleSpec: projection of the AppSpec for one role (runtime.yaml#service_endpoints.role_spec,
// ui/ui-kit.yaml#data_binding.role_spec). Hidden fields and other roles' permissions never leave the server.
import type { AppSpec } from "@wizard/appspec";
import type { ComplianceInfo } from "./compliance.js";

export interface RoleSpecOptions {
  role: string | null;
  compliance: ComplianceInfo;
  features: { phoneOtp: boolean };
}

export function buildRoleSpec(spec: AppSpec, o: RoleSpecOptions) {
  const role = o.role === null ? undefined : spec.roles.find((r) => r.name === o.role);
  const perms = role ? spec.permissions.filter((p) => p.role === role.name) : [];
  const methods = (list: readonly string[] | undefined) =>
    (list ?? []).filter((m) => m !== "phone_otp" || o.features.phoneOtp);
  const loginRoles = spec.roles.filter((r) => r.access === "login");
  return {
    app: { name: spec.app.name, description: spec.app.description ?? null, locale: spec.app.locale },
    theme: spec.theme ?? null,
    role: role
      ? { name: role.name, label: role.label, access: role.access, isAdmin: role.isAdmin === true }
      : null,
    entities: spec.entities
      .filter((e) => perms.some((p) => p.entity === e.name))
      .map((e) => {
        const hidden = new Set(perms.find((p) => p.entity === e.name)?.hiddenFields ?? []);
        return {
          name: e.name,
          label: e.label,
          ...(e.ownerField && !hidden.has(e.ownerField) ? { ownerField: e.ownerField } : {}),
          fields: e.fields.filter((f) => !hidden.has(f.name)),
        };
      }),
    permissions: perms.map((p) => ({
      role: p.role,
      entity: p.entity,
      ops: p.ops,
      ...(p.rowFilter ? { rowFilter: p.rowFilter } : {}),
      ...(p.readonlyFields ? { readonlyFields: p.readonlyFields } : {}),
    })),
    pages: (spec.pages ?? []).filter((p) => role !== undefined && p.roles.includes(role.name)),
    functions: (spec.functions ?? [])
      .filter(
        (f) =>
          f.public === true &&
          role !== undefined &&
          (f.roles ? f.roles.includes(role.name) : role.isAdmin === true),
      )
      .map((f) => ({ name: f.name, kind: f.kind })),
    loginRoles: loginRoles.map((r) => ({
      name: r.name,
      label: r.label,
      selfSignup: r.selfSignup === true,
      loginMethods: methods(r.loginMethods),
    })),
    loginMethods:
      role?.access === "login"
        ? methods(role.loginMethods)
        : [...new Set(loginRoles.flatMap((r) => methods(r.loginMethods)))],
    compliance: {
      consentText: o.compliance.consentText,
      policyPage: o.compliance.policyPage,
      policyVersion: o.compliance.policyVersion,
      consentTextHash: o.compliance.consentTextHash,
      operatorName: spec.compliance?.operatorName ?? null,
      operatorContact: spec.compliance?.operatorContact ?? null,
    },
  };
}

export type RoleSpec = ReturnType<typeof buildRoleSpec>;
