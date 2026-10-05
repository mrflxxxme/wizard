// zod schemas of orchestrator outputs: specs/agents/orchestrator.yaml#schemas and #system_card.
import { identSchema, PERMISSION_OPS, piiKindSchema } from "@wizard/appspec";
import { z } from "zod";
import { FORK_IDS } from "./taxonomy.js";

const str = (max: number) => z.string().trim().min(1).max(max);

/**
 * Segment = the closest quality recipe (D66): site, booking, crm — release classes; events, made_to_order — earlier
 * recipes; horizontal / other — the general pipeline only. A segment never limits what the system may contain.
 */
export const SEGMENTS = ["site", "booking", "crm", "events", "made_to_order", "horizontal", "other"] as const;
export const SKELETON = ["catalog", "application", "process", "payment", "fulfillment"] as const;
export const CONNECTORS = ["yookassa", "telegram", "email", "qr"] as const;
export const LOGIN_METHODS = ["phone_otp", "email_otp", "telegram"] as const;
export const FIELD_KINDS = [
  "text",
  "number",
  "money",
  "date",
  "choice",
  "link",
  "file",
  "contact",
  "qr",
] as const;
export const PLANS = ["free", "start", "business"] as const;

export const forkIdSchema = z.enum(FORK_IDS);
export const segmentSchema = z.enum(SEGMENTS);
export const accessSchema = z.enum(["public", "login"]);

export const analysisSchema = z.object({
  goals: z.array(str(300)).min(1).max(5),
  segment: segmentSchema,
  skeleton: z.array(z.enum(SKELETON)).max(5),
  roles: z
    .array(
      z.object({
        name: identSchema,
        label: str(60),
        access: accessSchema,
        isStaff: z.boolean(),
        evidence: z.string().max(300),
      }),
    )
    .min(1)
    .max(8),
  entities: z
    .array(
      z.object({
        name: identSchema,
        label: str(60),
        keyFields: z.array(z.string().min(1).max(60)).max(8),
        containsPii: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
  integrations: z.array(z.enum(CONNECTORS)),
  constraints: z.array(str(300)).max(20),
  resolved: z.array(
    z.object({ forkId: forkIdSchema, optionId: z.string().min(1), evidence: z.string().max(300) }),
  ),
  unknowns: z.array(forkIdSchema),
  outOfScope: z.array(str(300)).max(10),
  complexity: z.enum(["small", "medium", "large"]),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const questionOptionSchema = z.object({
  id: z.string().min(1).max(40),
  label: str(60),
  description: str(140).optional(),
  recommended: z.boolean(),
});

export const questionSchema = z.object({
  id: z.string().regex(/^q[1-7]$/),
  forkId: forkIdSchema,
  text: str(140),
  whyItMatters: str(160),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(4)
    .refine((o) => o.filter((x) => x.recommended).length === 1, "Ровно один вариант должен быть recommended"),
  allowCustom: z.boolean().default(true),
});
export type Question = z.infer<typeof questionSchema>;

export const askQuestionsSchema = z.object({ questions: z.array(questionSchema).min(1).max(7) });

export const answerSchema = z
  .object({
    questionId: z.string().regex(/^q[1-7]$/),
    forkId: forkIdSchema,
    optionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(500).optional(),
    byRecommendation: z.boolean(),
  })
  .refine((a) => (a.optionId === undefined) !== (a.text === undefined), "Нужен либо optionId, либо text");
export type Answer = z.infer<typeof answerSchema>;

export const acceptanceCheckSchema = z.object({
  type: z.enum(["permission", "scenario", "constraint"]),
  role: identSchema.optional(),
  entity: identSchema.optional(),
  op: z.enum(PERMISSION_OPS).optional(),
  expect: z.enum(["allow", "deny"]).optional(),
  milestone: z.enum(["M0", "M1", "M2", "M3", "M4"]).optional(),
});

export const cardRoleSchema = z.object({
  name: identSchema,
  label: str(60),
  access: accessSchema,
  loginMethods: z.array(z.enum(LOGIN_METHODS)).min(1).optional(),
  description: str(160),
  can: z.array(str(120)).max(8),
});

export const cardDataSchema = z.object({
  name: identSchema,
  label: str(60),
  fields: z
    .array(z.object({ label: str(60), kind: z.enum(FIELD_KINDS) }))
    .min(1)
    .max(12),
  pii: z.enum(["none", "basic"]),
});

export const cardScreenSchema = z.object({
  route: z.string().regex(/^\/[^\s]*$/),
  title: str(60),
  roles: z.array(identSchema).min(1),
  purpose: str(140),
});

export const cardIntegrationSchema = z.object({
  connector: z.enum(CONNECTORS),
  purpose: str(160),
  userActionRequired: str(160).optional(),
});

// biome-ignore lint/suspicious/noThenProperty: field name fixed by orchestrator.yaml#system_card.automations
export const cardAutomationSchema = z.object({ name: str(80), when: str(120), then: str(160) });

export const cardAcceptanceSchema = z.object({
  id: z.string().regex(/^AC[1-9]\d*$/),
  text: str(200),
  check: acceptanceCheckSchema,
});

export const cardPiiSchema = z.object({
  categories: z.array(piiKindSchema),
  fields: z.array(z.object({ entity: identSchema, field: identSchema, category: piiKindSchema })),
  retention: z.array(
    z.object({
      entity: identSchema,
      deleteAfterDays: z.number().int().min(1).max(3650),
      anchorField: identSchema.optional(),
      mode: z.enum(["delete", "anonymize"]),
      humanText: str(200),
    }),
  ),
  consent: z.boolean(),
  summary: z.string().max(300),
});

export const estimateSchema = z.object({
  credits: z.object({
    min: z.number().int().min(0),
    expected: z.number().int().min(0),
    max: z.number().int().min(0),
  }),
  minutes: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }),
});
export type Estimate = z.infer<typeof estimateSchema>;
export const capSchema = z.object({ credits: z.number().int().min(1) });

/** submit_card input: SystemCard without estimate/cap/cardVersion (filled by code). */
export const cardDraftSchema = z.object({
  title: str(80),
  summary: str(400),
  segment: segmentSchema,
  roles: z.array(cardRoleSchema).min(1).max(12),
  data: z.array(cardDataSchema).max(30),
  specVsCode: z.object({ spec: z.array(str(200)).max(12), code: z.array(str(200)).max(12) }),
  screens: z.array(cardScreenSchema).min(1).max(30),
  integrations: z.array(cardIntegrationSchema),
  automations: z.array(cardAutomationSchema).max(20),
  acceptance: z.array(cardAcceptanceSchema).min(3).max(20),
  pii: cardPiiSchema,
  assumptions: z.array(str(200)).max(20),
  outOfScope: z.array(str(300)).max(10),
  /** Filled by code from the session answers (the model's copy is ignored). */
  forkAnswers: z.array(answerSchema).default([]),
});
export type CardDraft = z.infer<typeof cardDraftSchema>;

export const systemCardSchema = cardDraftSchema.extend({
  forkAnswers: z.array(answerSchema),
  cardVersion: z.number().int().min(1),
  estimate: estimateSchema,
  cap: capSchema,
});
export type SystemCard = z.infer<typeof systemCardSchema>;

/** change_requests.small_edit: mini-card; only cardVersion, summary, estimate and cap are required. */
export const changeDraftSchema = cardDraftSchema
  .omit({ acceptance: true, forkAnswers: true })
  .partial()
  .extend({
    summary: str(400),
    acceptance: z.array(cardAcceptanceSchema).max(20).optional(),
  });
export type ChangeDraft = z.infer<typeof changeDraftSchema>;

export const changeCardSchema = changeDraftSchema.extend({
  kind: z.literal("change"),
  cardVersion: z.number().int().min(1),
  estimate: estimateSchema,
  cap: capSchema,
});
export type ChangeCard = z.infer<typeof changeCardSchema>;

export const CHANGE_KINDS = ["style_only", "small_edit", "big_change"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Model part of change classification (style_only is decided by code before the call). */
export const changeClassSchema = z.object({
  kind: z.enum(["small_edit", "big_change"]),
  summary: str(400),
  questions: z.array(questionSchema).max(2).default([]),
});
export type ChangeClass = z.infer<typeof changeClassSchema>;
