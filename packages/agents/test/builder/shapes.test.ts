// The AppSpec shapes of the builder's prompt are printed from the validator's zod schemas: every key and enum value of
// the schema is there, and the static prompt carries the block.
import { entitySchema, FIELD_TYPES, fieldSchema, workflowSchema } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { STATIC_PROMPT } from "../../src/builder/prompt.js";
import { shapeOf, specShapes } from "../../src/builder/shapes.js";

describe("AppSpec shapes in the prompt", () => {
  test("Field: every key (optional ones marked) and every field type", () => {
    const line = shapeOf(fieldSchema, true);
    for (const k of Object.keys(fieldSchema.shape)) expect(line).toMatch(new RegExp(`\\b${k}\\??: `));
    expect(line).toContain("name: ident");
    expect(line).toContain("required?: bool");
    for (const t of FIELD_TYPES) expect(line).toContain(`"${t}"`);
  });

  test("named sub-shapes and parenthesised enum arrays", () => {
    expect(shapeOf(entitySchema, true)).toContain("fields: Field[](1..80)");
    expect(shapeOf(workflowSchema, true)).toMatch(
      /steps: \{type: "update"\|.*params\?: object\}\[\]\(1\.\.20\)/,
    );
    expect(specShapes()).toContain('ops: ("read"|"create"|"update"|"delete")[]');
  });

  test("the static prompt carries the block after the ops list", () => {
    const i = STATIC_PROMPT.indexOf("# AppSpec operations");
    const j = STATIC_PROMPT.indexOf("Точные формы объектов");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});
