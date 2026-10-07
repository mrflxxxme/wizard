// F4 on the beta v2 path (B2-41, mvp-04 of the D76 measurement): an org without SMS login gets «Код на почту» instead
// of «Код по телефону» in the login parameters of its plan's modules; other parameters and modules stay as they are.
import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "../src/planner/catalog.js";
import { withoutPhoneLogin } from "../src/planner/login.js";

const plan = (modules: SystemPlan["modules"]): SystemPlan =>
  ({ version: 1, niche: "салон", goals: [], modules, outOfScope: [], custom: [] }) as unknown as SystemPlan;

describe("withoutPhoneLogin", () => {
  it("phone_otp of staff and the visitor cabinet becomes email_otp", () => {
    const r = withoutPhoneLogin(
      plan([
        { id: "staff", params: { login: "phone_otp", see_only_own: true } },
        { id: "visitor_cabinet", params: { login: "phone_otp" } },
        { id: "client_card", params: { match_by: "phone" } },
      ]),
      DEFAULT_REGISTRY,
    );
    expect(r.changed).toBe(true);
    expect(r.plan.modules).toEqual([
      { id: "staff", params: { login: "email_otp", see_only_own: true } },
      { id: "visitor_cabinet", params: { login: "email_otp" } },
      { id: "client_card", params: { match_by: "phone" } },
    ]);
  });

  it("a plan without phone login is returned as is", () => {
    const p = plan([{ id: "staff", params: { login: "telegram" } }, { id: "notify" }]);
    const r = withoutPhoneLogin(p, DEFAULT_REGISTRY);
    expect(r).toEqual({ plan: p, changed: false });
  });
});
