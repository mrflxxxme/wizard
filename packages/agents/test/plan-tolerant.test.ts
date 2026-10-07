// B2-41: tolerant reading of submit_plan arguments — extra fields named in Russian without a label (mvp-07 of the D76
// measurement) become field_<n> with the Russian name as the label, valid fields stay as they are.
import { describe, expect, it } from "vitest";
import { normalizePlanArgs } from "../src/planner/tolerant.js";

describe("normalizePlanArgs: extra fields", () => {
  it("a Russian name becomes the label, the name becomes field_<n>; valid fields are kept", () => {
    const out = normalizePlanArgs({
      version: 1,
      modules: [
        {
          id: "leads",
          params: {
            extra_fields: [
              { name: "Бюджет покупки", type: "string" },
              { name: "field_1", label: "Район", type: "string" },
              { name: "rooms", type: "int" },
            ],
          },
        },
        { id: "notify" },
      ],
    }) as { modules: { params?: { extra_fields?: unknown[] } }[] };
    expect(out.modules[0]?.params?.extra_fields).toEqual([
      { name: "field_2", label: "Бюджет покупки", type: "string" },
      { name: "field_1", label: "Район", type: "string" },
      { name: "rooms", label: "rooms", type: "int" },
    ]);
    expect(out.modules[1]).toEqual({ id: "notify" });
  });

  it("other params are not touched", () => {
    const plan = { modules: [{ id: "catalog", params: { with_duration: true, tags: ["a", "b"] } }] };
    expect(normalizePlanArgs(plan)).toEqual(plan);
  });
});
