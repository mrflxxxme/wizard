// FU-4: GET /_wizard/spec (runtime buildRoleSpec) and ui-kit's RoleSpec are one contract
// (ui-kit.yaml#data_binding.role_spec, runtime.yaml#service_endpoints.role_spec): WzProvider takes the body as is.
import { buildRoleSpec, complianceInfo } from "@wizard/runtime";
import { type RoleSpec, toRoleSpec } from "@wizard/ui-kit";
import { describe, expect, test } from "vitest";
import { loadBakery } from "./g1-helpers.js";
import { loadForum } from "./helpers.js";

describe.each([
  ["forum", loadForum()],
  ["bakery", loadBakery().spec],
])("RoleSpec contract on %s", (_n, spec) => {
  const serve = (role: string | null): RoleSpec =>
    // Type-level half of the contract: the runtime body is assignable to ui-kit's RoleSpec.
    buildRoleSpec(spec, { role, compliance: complianceInfo(spec), features: { phoneOtp: true } });

  test.each(spec.roles.map((r) => r.name))("role %s: same role, roles, permissions, pages", (role) => {
    const got = serve(role);
    const kit = toRoleSpec(spec, role);
    expect(got.role).toBe(kit.role);
    expect(got.roles).toEqual(kit.roles);
    expect(got.permissions.map((p) => [p.entity, p.ops])).toEqual(
      kit.permissions.map((p) => [p.entity, p.ops]),
    );
    expect(got.pages.map((p) => p.route)).toEqual(kit.pages.map((p) => p.route));
    // The runtime ships only entities the role can touch, without hidden fields.
    for (const e of got.entities)
      expect(e.fields.map((f) => f.name)).toEqual(
        kit.entities.find((x) => x.name === e.name)?.fields.map((f) => f.name),
      );
    // A logged-in role sees its own methods; everyone else the union (as ui-kit computes it).
    if (spec.roles.find((r) => r.name === role)?.access !== "login")
      expect(got.loginMethods).toEqual(kit.loginMethods);
  });

  test("no nulls where ui-kit expects optional fields", () => {
    const body = JSON.stringify(serve(spec.roles[0]?.name ?? null));
    expect(body).not.toContain(":null");
    expect(serve(null).role).toBeNull();
  });
});
