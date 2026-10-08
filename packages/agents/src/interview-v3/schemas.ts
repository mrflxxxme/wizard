// Grill interview of v3 (V3-03; product.yaml#decisions.D77_v3 (8), (9), (12); docs/reviews/grill-8.md № 8, 9, 12;
// builder-v3.md §3 C1, C7, C8): constants, the zod schemas of the model's tools and the session types. One question per
// turn along the tree goals → audience → scenarios → data → roles → integrations → content → launch limits; every
// question has 3–5 buttons with exactly one recommended (and why), «Решите за меня» and an own answer.
import {
  BRIEF_ACTORS,
  BRIEF_INTEGRATION_DIRECTIONS,
  BRIEF_PRIORITIES,
  type SystemBrief,
} from "@wizard/appspec";
import { z } from "zod";

/** Route of the interview model (models.yaml#routes.interview_v3, C7). */
export const INTERVIEW_V3_CALL_TYPE = "interview_v3" as const;

/** Hard cap of questions per interview (grill-8 № 8: usually 5–10, never more than 15). */
export const MAX_V3_QUESTIONS = 15;

/** Model calls of one turn: up to 3 searches and 2 page reads (research), the brief update with the question or finish. */
export const V3_TURN_MAX_CALLS = 6;

/** Research of one interview (C8 tools; the build has its own, larger limits): paid searches and page reads. */
export const INTERVIEW_RESEARCH_LIMITS = { searches: 3, pages: 2 } as const;

/** The question tree in its order (grill-8 № 8). */
export const V3_TOPICS = [
  "goals",
  "audience",
  "scenarios",
  "data",
  "roles",
  "integrations",
  "content",
  "constraints",
] as const;
export type V3Topic = (typeof V3_TOPICS)[number];

/** Russian names of the tree topics (chat, assumptions, prompts). */
export const V3_TOPIC_LABELS: Readonly<Record<V3Topic, string>> = {
  goals: "Цели",
  audience: "Аудитория",
  scenarios: "Сценарии",
  data: "Данные",
  roles: "Роли и доступы",
  integrations: "Интеграции",
  content: "Контент",
  constraints: "Ограничения запуска",
};

/**
 * Reserved option id of «Решите за меня» in the platform form of a question (pending_questions): the answers API
 * accepts it like any option, the executor turns it into a delegated answer. The model never uses this id.
 */
export const DELEGATE_OPTION_ID = "delegate";
export const DELEGATE_LABEL = "Решите за меня";
export const FINISH_LABEL = "Дальше решай сам";

/** Default retention of a data entity when nobody said otherwise (a decision, not a fact — no invented terms). */
export const DEFAULT_RETENTION = "пока нужны для работы; удаляем по просьбе человека";

const str = (max: number) => z.string().trim().min(1).max(max);

export const v3OptionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: str(80),
  description: str(160).optional(),
  recommended: z.boolean(),
});
export type V3Option = z.infer<typeof v3OptionSchema>;

/** submit_question: the next blocking question (the code numbers it and checks the tree order). */
export const v3QuestionInputSchema = z.object({
  topic: z.enum(V3_TOPICS),
  text: str(200),
  /** What the answer changes in the system (one sentence). */
  whyItMatters: str(240),
  /** Why the recommended option fits (one or two sentences, no invented numbers). */
  recommendation: str(240),
  options: z
    .array(v3OptionSchema)
    .min(3)
    .max(5)
    .refine((o) => o.filter((x) => x.recommended).length === 1, "Ровно один вариант должен быть recommended")
    .refine((o) => new Set(o.map((x) => x.id)).size === o.length, "id вариантов не должны повторяться"),
  allowDelegate: z.boolean().default(true),
});
export type V3QuestionInput = z.output<typeof v3QuestionInputSchema>;

/** A question as the session keeps it: numbered, with the source; fallback questions carry a brief patch per option. */
export interface V3Question extends V3QuestionInput {
  /** q1…q15 in the order asked. */
  id: string;
  /** 1-based number of the question in the interview. */
  step: number;
  source: "model" | "fallback";
  /** Fallback questions only: what each option writes into the brief (no model needed to apply the answer). */
  patches?: Record<string, BriefPatch>;
}

/** defer_question: a non-blocking question goes to the build queue with the assumption used meanwhile. */
export const v3DeferInputSchema = z.object({
  topic: z.enum(V3_TOPICS),
  text: str(200),
  assumption: str(300),
});
export type DeferredQuestion = z.output<typeof v3DeferInputSchema>;

const goalPatch = z.object({ id: z.string().optional(), text: str(400), success: str(400) });
const scenarioPatch = z.object({
  id: z.string().optional(),
  actor: z.enum(BRIEF_ACTORS),
  when: str(400),
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 («Когда…, система…»)
  then: z.array(str(400)).min(1).max(12),
  goalId: z.string().optional(),
  moduleHint: z.string().optional(),
  priority: z.enum(BRIEF_PRIORITIES).default("must"),
});
const rolePatch = z.object({ id: z.string().optional(), name: str(120), can: z.array(str(400)).max(30) });
const dataPatch = z.object({
  entity: str(120),
  fields: z.array(z.object({ name: str(120), pii: z.boolean().optional() })).max(60),
  retention: str(400),
});
const integrationPatch = z.object({
  id: z.string().optional(),
  name: str(120),
  direction: z.enum(BRIEF_INTEGRATION_DIRECTIONS).default("out"),
  contractRef: z.string().trim().max(500).optional(),
});

/** submit_brief_update: what the turn adds to the brief (lists are merged by id or main text, never wiped). */
export const briefPatchSchema = z.object({
  goals: z.array(goalPatch).max(10).optional(),
  audience: z.string().trim().max(2000).optional(),
  scenarios: z.array(scenarioPatch).max(30).optional(),
  roles: z.array(rolePatch).max(20).optional(),
  data: z.array(dataPatch).max(40).optional(),
  integrations: z.array(integrationPatch).max(20).optional(),
  outOfScope: z
    .array(z.object({ text: str(400), substitute: str(400).optional() }))
    .max(20)
    .optional(),
  /** The agent's decisions the owner did not make (the code sets their source). */
  assumptions: z
    .array(z.object({ text: str(400) }))
    .max(30)
    .optional(),
  /** Requirements that are not a scenario or an integration (online payment, delivery, exchange with 1С…). */
  requirements: z
    .array(z.object({ text: str(400), moduleHint: z.string().optional() }))
    .max(30)
    .optional(),
  /** Facts about the niche found by web_search / read_page, with the source address (never shown as fact). */
  facts: z
    .array(
      z.object({
        text: str(300),
        url: z
          .string()
          .trim()
          .regex(/^https?:\/\/\S+$/),
      }),
    )
    .max(10)
    .optional(),
});
export type BriefPatch = z.output<typeof briefPatchSchema>;

/** finish_interview: the model says nothing blocking is left; the code checks it (blockingGaps). */
export const v3FinishInputSchema = z.object({ note: z.string().trim().max(300).optional() });

/** One extra requirement of the capability map (from the ТЗ or the answers, not a scenario). */
export interface ExtraRequirement {
  text: string;
  moduleHint?: string;
}

/** A fact about the niche the agent found (session only; the brief has no field for facts). */
export interface NicheFact {
  text: string;
  url: string;
}

export type V3State = "idle" | "asking" | "ready" | "failed";

/** Interview state between turns (the host persists it as JSON with the turn, like GoalSession). */
export interface InterviewV3Session {
  v: 1;
  /** Marks the v3 path: the host keeps a system on the pipeline it started with. */
  pipeline: "v3";
  state: V3State;
  /** The owner's first message (or the text of the ТЗ). */
  prompt: string | null;
  /** The working brief: what the host saves as a new version after the turn. */
  brief: SystemBrief;
  /** The stored brief version this session's brief is based on (0 — none yet). */
  baseVersion: number;
  /** Questions asked so far (cap MAX_V3_QUESTIONS). */
  asked: number;
  current: V3Question | null;
  /** Topic of the last question asked (the tree goes forward). */
  lastTopic: V3Topic | null;
  /** Topics the fallback has asked about already (a second time the default is taken). */
  fallbackTopics: V3Topic[];
  requirements: ExtraRequirement[];
  /** Non-blocking questions: asked during the build (C6), each with the assumption the build uses meanwhile. */
  deferred: DeferredQuestion[];
  facts: NicheFact[];
  research: { searches: number; pages: number };
  /** not_yet requirements already recorded as development requests (D73), by normalized text. */
  recorded: string[];
  piiInBrief: boolean;
  piiNoticeShown: boolean;
  llmCalls: number;
  creditsCharged: number;
}
