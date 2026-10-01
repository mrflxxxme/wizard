// zod shapes of the QA tools: submit_checks (Scenario DSL, quality/gates.yaml#scenario_dsl) and submit_explanations
// (agents/qa.yaml#explain.Explanation).
import { SEED_HINT_MAX_VALUES } from "@wizard/gates";
import { z } from "zod";
import { defineTool } from "../core/index.js";
import { EXPLANATION_CATEGORIES } from "./types.js";

const ident = z.string().regex(/^[a-z][a-z0-9_]*$/);
const record = z.record(z.string(), z.unknown());
const save = ident.optional();

export const expectSchema = z.strictObject({
  status: z
    .union([
      z.enum(["ok", "created", "denied", "not_found", "invalid", "conflict", "limit"]),
      z.number().int(),
    ])
    .optional(),
  error: z.string().min(1).optional(),
  fields: record.optional(),
  absentFields: z.array(z.string()).optional(),
  count: z
    .union([
      z.number().int().min(0),
      z.strictObject({ gte: z.number().int().min(0).optional(), lte: z.number().int().min(0).optional() }),
    ])
    .optional(),
  outbox: z
    .strictObject({
      connector: z.string(),
      count: z.number().int().min(0).optional(),
      to: z.string().optional(),
      containsFields: z.array(z.string()).optional(),
    })
    .optional(),
});

export const stepSchema = z.strictObject({
  as: z.union([z.string(), z.strictObject({ role: ident })]).optional(),
  create: z.strictObject({ entity: ident, data: record, save }).optional(),
  read: z
    .strictObject({ entity: ident, id: z.unknown().optional(), where: record.optional(), save })
    .optional(),
  update: z.strictObject({ entity: ident, id: z.unknown(), data: record, save }).optional(),
  delete: z.strictObject({ entity: ident, id: z.unknown() }).optional(),
  callFn: z.strictObject({ name: z.string(), args: record.optional(), save }).optional(),
  simulate: z.strictObject({ connector: z.string(), event: z.string(), data: record.optional() }).optional(),
  runWorkflows: z.strictObject({}).optional(),
  advanceTime: z.strictObject({ minutes: z.number().int() }).optional(),
  expect: expectSchema.optional(),
  consent: z.literal(true).optional(),
});

/** qa.yaml#seed.rules MAY: plausible non-personal values for a pii=none field; values[i] → row i of the seed. */
export const seedHintSchema = z.strictObject({
  entity: ident,
  field: ident,
  values: z
    .array(z.union([z.string().min(1).max(500), z.number(), z.boolean()]))
    .min(1)
    .max(SEED_HINT_MAX_VALUES),
});

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^SC-AC\d{1,3}(-\d{1,2})?$/),
  acId: z.string().regex(/^AC\d{1,3}$/),
  title: z.string().min(1).max(140),
  actors: z.record(ident, z.strictObject({ role: ident })),
  milestone: z.enum(["M0", "M1", "M2", "M3", "M4"]).optional(),
  seed: z.enum(["default", "none"]).optional(),
  seedHints: z.array(seedHintSchema).max(20).optional(),
  steps: z.array(stepSchema).min(1).max(40),
});

/** The model sees the full DSL schema; arguments are validated scenario by scenario (qa.yaml#…scenario.validate). */
export const submitChecksTool = defineTool({
  name: "submit_checks",
  description: "Submit executable acceptance scenarios (Scenario DSL), at least one per requested AC.",
  input: z.strictObject({ checks: z.array(scenarioSchema).min(1).max(40) }),
});

export const explanationSchema = z.strictObject({
  checkId: z.string(),
  acId: z.string().optional(),
  category: z.enum(EXPLANATION_CATEGORIES),
  expected: z.string().max(400),
  actual: z.string().max(600),
  likelyCause: z.string().max(600),
  fix: z.strictObject({
    kind: z.enum(["ops", "code", "none"]),
    target: z.string().max(200),
    suggestion: z.string().max(600),
  }),
  owner: z.enum(["builder", "qa"]),
});

export const submitExplanationsTool = defineTool({
  name: "submit_explanations",
  description: "Submit one explanation per failed check: category, expected/actual, likely cause and fix.",
  input: z.strictObject({ explanations: z.array(explanationSchema).min(1).max(40) }),
});
