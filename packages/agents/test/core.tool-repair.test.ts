// Open models send nested arrays/objects as JSON strings (D67 fallback on glm-5.1, 06.10.2026: "acceptance": "[…]"):
// defineTool decodes such fields and checks again; a non-JSON string or a wrong JSON kind stays an issue.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/core/tool.js";

const t = defineTool({
  name: "submit_analysis",
  description: "x",
  input: z.object({
    goals: z.array(z.string()).min(1),
    acceptance: z.array(z.object({ id: z.string(), text: z.string() })),
    meta: z.object({ segment: z.enum(["site", "booking"]) }),
  }),
});

describe("defineTool: JSON strings in place of arrays and objects", () => {
  test("decodes nested JSON strings (top level and inside an object) and accepts the arguments", () => {
    const r = t.parse({
      goals: '["Заявки"]',
      acceptance: JSON.stringify([{ id: "AC1", text: "Посетитель отправляет заявку" }]),
      meta: '{"segment":"site"}',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        goals: ["Заявки"],
        acceptance: [{ id: "AC1", text: "Посетитель отправляет заявку" }],
        meta: { segment: "site" },
      },
    });
  });

  test("a non-JSON string, an object where an array is expected and a wrong enum stay issues", () => {
    const r = t.parse({ goals: "Заявки", acceptance: '{"id":"AC1"}', meta: { segment: "лендинг" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path).sort()).toEqual(["acceptance", "goals", "meta.segment"]);
  });
});
