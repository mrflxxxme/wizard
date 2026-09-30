// M0-30: the build tier (models.yaml#week0_decision.switch) has one source — createRegistry, env
// WIZARD_BUILD_DEFAULT_TIER — and the build model label (api.yaml#OrgSettings.buildModelLabel) follows it.
import { describe, expect, test } from "vitest";
import {
  BUILD_TIER_ENV,
  buildDefaultTierFromEnv,
  buildModelLabel,
  createRegistry,
  createRouter,
  DEFAULT_BUILD_TIER,
  RU_BUILD_LABEL,
} from "../src/index.js";

const open = { ruOnly: false, t1Restricted: false };

describe("build default tier", () => {
  test("unset or empty env → default of week0_decision (t1_default: true)", () => {
    expect(DEFAULT_BUILD_TIER).toBe("T1");
    expect(buildDefaultTierFromEnv({})).toBe("T1");
    expect(buildDefaultTierFromEnv({ [BUILD_TIER_ENV]: "" })).toBe("T1");
  });

  test("env T0/T1 is taken as is, other values fail loudly", () => {
    expect(buildDefaultTierFromEnv({ [BUILD_TIER_ENV]: "T0" })).toBe("T0");
    expect(buildDefaultTierFromEnv({ [BUILD_TIER_ENV]: " T1 " })).toBe("T1");
    expect(() => buildDefaultTierFromEnv({ [BUILD_TIER_ENV]: "t0" })).toThrow(/T0 or T1/);
  });

  test("createRegistry reads env; an explicit override wins", () => {
    expect(createRegistry({}, { [BUILD_TIER_ENV]: "T0" }).buildDefaultTier).toBe("T0");
    expect(createRegistry({ buildDefaultTier: "T1" }, { [BUILD_TIER_ENV]: "T0" }).buildDefaultTier).toBe(
      "T1",
    );
  });

  test("createRouter builds its registry from opts.env", () => {
    const r = createRouter({ mode: "live", env: { [BUILD_TIER_ENV]: "T0" } });
    expect(r.registry.buildDefaultTier).toBe("T0");
    expect(() => createRouter({ mode: "live", env: { [BUILD_TIER_ENV]: "x" } })).toThrow(/T0 or T1/);
  });
});

describe("buildModelLabel", () => {
  test("T1 by default and an open org → GLM-5.3", () => {
    expect(buildModelLabel(createRegistry({ buildDefaultTier: "T1" }), open)).toBe("GLM-5.3");
  });

  test("T0 by default (F2) → «модели в РФ»", () => {
    expect(RU_BUILD_LABEL).toBe("модели в РФ");
    expect(buildModelLabel(createRegistry({ buildDefaultTier: "T0" }), open)).toBe("модели в РФ");
  });

  test("ruOnly, t1Restricted or an unknown policy → «модели в РФ» even with T1 by default", () => {
    const reg = createRegistry({ buildDefaultTier: "T1" });
    expect(buildModelLabel(reg, { ruOnly: true, t1Restricted: false })).toBe(RU_BUILD_LABEL);
    expect(buildModelLabel(reg, { ruOnly: false, t1Restricted: true })).toBe(RU_BUILD_LABEL);
    expect(buildModelLabel(reg, { ruOnly: false })).toBe(RU_BUILD_LABEL);
    expect(buildModelLabel(reg, null)).toBe(RU_BUILD_LABEL);
  });
});
