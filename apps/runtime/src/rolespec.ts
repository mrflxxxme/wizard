// RoleSpec: projection of the AppSpec for one role (runtime.yaml#service_endpoints.role_spec,
// ui/ui-kit.yaml#data_binding.role_spec). Hidden fields and other roles' permissions never leave the server.
// One contract with ui-kit's RoleSpec (role — name, roles — all roles without permissions); WzProvider takes the
// body of GET /_wizard/spec as is. Contract test: packages/gates/test/rolespec-contract.test.ts.
import type { AppSpec } from "@wizard/appspec";
import { compilePolicy } from "@wizard/sdk/host";
import type { ComplianceInfo } from "./compliance.js";

export interface RoleSpecOptions {
  role: string | null;
  compliance: ComplianceInfo;
  features: { phoneOtp: boolean };
  /** Drafts of a Free org show phone_otp with the plan note (runtime.yaml#auth.methods_M1.phone_otp, F4). */
  env?: "draft" | "prod";
}

type LoginMethod = "phone_otp" | "email_otp" | "telegram";
const METHOD_ORDER: readonly LoginMethod[] = ["email_otp", "phone_otp", "telegram"];

export function buildRoleSpec(spec: AppSpec, o: RoleSpecOptions) {
  const role = o.role === null ? undefined : spec.roles.find((r) => r.name === o.role);
  const perms = role ? spec.permissions.filter((p) => p.role === role.name) : [];
  const phoneAllowed = o.features.phoneOtp || o.env === "draft";
  const methods = (list: readonly string[] | undefined) =>
    (list ?? []).filter((m): m is LoginMethod => m !== "phone_otp" || phoneAllowed);
  const loginRoles = spec.roles.filter((r) => r.access === "login");
  const loginMethods = new Set(
    role?.access === "login"
      ? methods(role.loginMethods)
      : loginRoles.flatMap((r) => methods(r.loginMethods)),
  );
  const c = o.compliance;
  return {
    app: {
      name: spec.app.name,
      ...(spec.app.description ? { description: spec.app.description } : {}),
      locale: spec.app.locale,
    },
    ...(spec.theme ? { theme: spec.theme } : {}),
    role: role ? role.name : null,
    roles: spec.roles.map((r) => ({
      name: r.name,
      label: r.label,
      access: r.access,
      ...(r.isAdmin ? { isAdmin: true } : {}),
      ...(r.selfSignup ? { selfSignup: true } : {}),
    })),
    entities: spec.entities
      .filter((e) => perms.some((p) => p.entity === e.name))
      .map((e) => {
        // Declared hiddenFields plus implicit ones (qr_token of other people's rows, connectors/qr.yaml#token).
        const hidden = compilePolicy(spec, e.name, { id: null, role: role?.name ?? "" }).hidden;
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
    loginMethods: METHOD_ORDER.filter((m) => loginMethods.has(m)),
    ...(!o.features.phoneOtp && loginMethods.has("phone_otp") ? { phoneOtpPlanNote: true } : {}),
    compliance: {
      ...(c.consentText ? { consentText: c.consentText } : {}),
      ...(c.policyPage ? { policyPage: c.policyPage } : {}),
      policyVersion: c.policyVersion,
      consentTextHash: c.consentTextHash,
      ...(spec.compliance?.operatorName ? { operatorName: spec.compliance.operatorName } : {}),
      ...(spec.compliance?.operatorContact ? { operatorContact: spec.compliance.operatorContact } : {}),
    },
  };
}

export type RoleSpec = ReturnType<typeof buildRoleSpec>;
