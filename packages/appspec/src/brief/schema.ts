// System brief of v3 (product.yaml#decisions.D77_v3 (8), (9); specs/agents/builder-v3.md §3 C1): the versioned artifact
// the grill interview fills and both the owner and the build agents check against. Goals with success signs, audience,
// «Когда…, система…» scenarios (acceptance criteria of the build), roles and access, data with ПДн and retention,
// integrations, design direction, what is out of scope, assumptions, the question → answer journal and the capability
// map. Data only; versions and their diff are in ./diff.ts, the three diagrams in ./diagrams.ts.
import { z } from "zod";
import { fromZodIssues } from "../errors.js";
import { SCENARIO_ACTORS } from "../modules/manifest.js";
import { IDENT_RE, SECRET_REF_RE } from "../schema.js";

/**
 * Size limits of a brief: list lengths, text lengths and the whole JSON in UTF-8 bytes — neither a model nor a pasted
 * ТЗ can bloat the artifact every build stage reads.
 */
export const BRIEF_LIMITS = {
  goals: 10,
  scenarios: 60,
  scenarioSteps: 12,
  roles: 20,
  roleCan: 30,
  data: 40,
  dataFields: 60,
  integrations: 20,
  references: 5,
  outOfScope: 40,
  assumptions: 60,
  qa: 60,
  capability: 100,
  /** Names: role, entity, field, integration. */
  name: 120,
  /** One statement: goal, success sign, «когда», «система», access, retention, assumption, requirement. */
  text: 400,
  /** Question, recommended answer, reference, contract reference. */
  question: 500,
  /** Audience and answers of the owner. */
  longText: 2000,
  /** The whole brief as JSON. */
  bytes: 256 * 1024,
} as const;

/** Who acts in a scenario (the same set as goal scenarios of module manifests). */
export const BRIEF_ACTORS = SCENARIO_ACTORS;
/** must — acceptance criterion of the build (V3-11 turns it into a feature and a browser check); should — desirable. */
export const BRIEF_PRIORITIES = ["must", "should"] as const;
/** out — the system calls the external API; in — the external side calls the API the system publishes. */
export const BRIEF_INTEGRATION_DIRECTIONS = ["out", "in"] as const;
/** default — the agent's default; owner_skip — the owner pressed «Дальше решай сам» and the rest became assumptions. */
export const BRIEF_ASSUMPTION_SOURCES = ["default", "owner_skip"] as const;
/** How a question was answered: the recommended answer, one of the buttons, own text, «Решите за меня». */
export const BRIEF_QA_CHOICES = ["recommended", "option", "custom", "delegated"] as const;
/** Capability map (D77 (12)): on proven modules, own code with a mark, not yet — to development requests. */
export const BRIEF_CAPABILITY_LEVELS = ["modules", "custom", "not_yet"] as const;

/** Top-level fields of a brief in display order (the panel, the diff and the error texts follow it). */
export const BRIEF_FIELDS = [
  "goals",
  "audience",
  "scenarios",
  "roles",
  "data",
  "integrations",
  "design",
  "outOfScope",
  "assumptions",
  "qa",
  "capability",
] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

const FIELD_LABELS: Record<BriefField, string> = {
  goals: "Цели",
  audience: "Аудитория",
  scenarios: "Сценарии",
  roles: "Роли и доступы",
  data: "Данные",
  integrations: "Интеграции",
  design: "Дизайн",
  outOfScope: "Не входит",
  assumptions: "Допущения",
  qa: "Вопросы и ответы",
  capability: "Карта возможностей",
};
/** Russian names of the brief sections. */
export const BRIEF_FIELD_LABELS: Readonly<Record<BriefField, string>> = FIELD_LABELS;

/** Russian names of the properties inside brief items (errors and diff texts). */
export const BRIEF_PROP_LABELS: Readonly<Record<string, string>> = {
  id: "Id",
  text: "Текст",
  success: "Признак успеха",
  actor: "Кто действует",
  when: "Когда",
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 (scenarios[].then)
  then: "Что делает система",
  goalId: "Цель",
  moduleHint: "Модуль",
  priority: "Приоритет",
  name: "Название",
  can: "Доступы",
  entity: "Что хранится",
  fields: "Поля",
  pii: "Персональные данные",
  retention: "Срок хранения",
  direction: "Направление",
  contractRef: "Контракт API",
  secretRef: "Ключ",
  archetype: "Архетип",
  pinned: "Выбрано владельцем",
  references: "Референсы",
  substitute: "Замена",
  source: "Источник",
  q: "Вопрос",
  a: "Ответ",
  recommended: "Рекомендация",
  chosen: "Как ответили",
  requirement: "Требование",
  level: "Уровень",
};

export const BRIEF_ERROR_CODES = [
  "SCHEMA_INVALID",
  "LIMIT_EXCEEDED",
  "DUPLICATE_ID",
  "UNKNOWN_REF",
  "TOO_LARGE",
] as const;
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number];

const L = BRIEF_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);
const briefId = z.string().regex(IDENT_RE);
const list = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .default(() => []);

const goalSchema = z.strictObject({ id: briefId, text: text(L.text), success: text(L.text) });

const scenarioSchema = z.strictObject({
  id: briefId,
  actor: z.enum(BRIEF_ACTORS),
  when: text(L.text),
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1 («Когда…, система…»)
  then: z.array(text(L.text)).min(1).max(L.scenarioSteps),
  goalId: briefId.optional(),
  /** Catalog module that most likely closes the scenario (a hint for the build, not a binding). */
  moduleHint: briefId.optional(),
  priority: z.enum(BRIEF_PRIORITIES).default("must"),
});

const roleSchema = z.strictObject({ id: briefId, name: text(L.name), can: list(text(L.text), L.roleCan) });

const dataSchema = z.strictObject({
  entity: text(L.name),
  fields: list(z.strictObject({ name: text(L.name), pii: z.boolean().optional() }), L.dataFields),
  /** How long the records are kept («3 года после последнего визита», «до отзыва согласия»). */
  retention: text(L.text),
});

const integrationSchema = z.strictObject({
  id: briefId,
  name: text(L.name),
  direction: z.enum(BRIEF_INTEGRATION_DIRECTIONS),
  /** Where the API contract lies (file of the system repository or documentation URL); no spaces. */
  contractRef: text(L.question).regex(/^\S+$/).optional(),
  /** The key only as secret://name (AGENTS.md: connector secrets never in the spec). */
  secretRef: z.string().regex(SECRET_REF_RE).optional(),
});

const designSchema = z.strictObject({
  /** Archetype id of the design system (C2 ARCHETYPES). */
  archetype: briefId.optional(),
  /** The owner chose the direction by hand: the design stage keeps it. */
  pinned: z.boolean().optional(),
  /** 1–3 references of the owner (link, uploaded screenshot, words): principles without copying (GZ-03). */
  references: list(text(L.question), L.references),
});

export const systemBriefSchema = z
  .strictObject({
    goals: list(goalSchema, L.goals),
    audience: z.string().trim().max(L.longText).default(""),
    scenarios: list(scenarioSchema, L.scenarios),
    roles: list(roleSchema, L.roles),
    data: list(dataSchema, L.data),
    integrations: list(integrationSchema, L.integrations),
    design: designSchema.default(() => ({ references: [] })),
    outOfScope: list(
      z.strictObject({ text: text(L.text), substitute: text(L.text).optional() }),
      L.outOfScope,
    ),
    assumptions: list(
      z.strictObject({ text: text(L.text), source: z.enum(BRIEF_ASSUMPTION_SOURCES) }),
      L.assumptions,
    ),
    qa: list(
      z.strictObject({
        q: text(L.question),
        a: text(L.longText),
        recommended: z.string().trim().max(L.question),
        chosen: z.enum(BRIEF_QA_CHOICES),
      }),
      L.qa,
    ),
    capability: list(
      z.strictObject({ requirement: text(L.text), level: z.enum(BRIEF_CAPABILITY_LEVELS) }),
      L.capability,
    ),
  })
  .superRefine((b, ctx) => {
    const issue = (code: BriefErrorCode, path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message, params: { briefCode: code } });
    for (const field of ["goals", "scenarios", "roles", "integrations"] as const) {
      const seen = new Set<string>();
      (b[field] as readonly { id: string }[]).forEach(({ id }, i) => {
        if (seen.has(id))
          issue(
            "DUPLICATE_ID",
            [field, i, "id"],
            `Id «${id}» в разделе «${FIELD_LABELS[field]}» повторяется`,
          );
        seen.add(id);
      });
    }
    const goals = new Set(b.goals.map((g) => g.id));
    b.scenarios.forEach((s, i) => {
      if (s.goalId !== undefined && !goals.has(s.goalId))
        issue(
          "UNKNOWN_REF",
          ["scenarios", i, "goalId"],
          `Сценарий «${s.id}» ссылается на цель «${s.goalId}», которой нет в брифе`,
        );
    });
    const entities = new Set<string>();
    b.data.forEach((d, i) => {
      const key = d.entity.toLowerCase();
      if (entities.has(key))
        issue("DUPLICATE_ID", ["data", i, "entity"], `Данные «${d.entity}» описаны дважды`);
      entities.add(key);
      const fields = new Set<string>();
      d.fields.forEach((f, j) => {
        const fk = f.name.toLowerCase();
        if (fields.has(fk))
          issue(
            "DUPLICATE_ID",
            ["data", i, "fields", j, "name"],
            `Поле «${f.name}» в данных «${d.entity}» повторяется`,
          );
        fields.add(fk);
      });
    });
    const bytes = new TextEncoder().encode(JSON.stringify(b)).length;
    if (bytes > L.bytes)
      issue(
        "TOO_LARGE",
        [],
        `Бриф слишком большой: ${Math.ceil(bytes / 1024)} КБ при лимите ${L.bytes / 1024} КБ — сократите тексты или списки`,
      );
  });

/** The brief as stored and read by the agents (defaults applied). */
export type SystemBrief = z.output<typeof systemBriefSchema>;
/** The brief as written by the interview or the owner (lists and audience may be omitted). */
export type SystemBriefInput = z.input<typeof systemBriefSchema>;
export type BriefGoal = SystemBrief["goals"][number];
export type BriefScenario = SystemBrief["scenarios"][number];
export type BriefRole = SystemBrief["roles"][number];
export type BriefData = SystemBrief["data"][number];
export type BriefIntegration = SystemBrief["integrations"][number];
export type BriefQa = SystemBrief["qa"][number];
export type BriefCapability = SystemBrief["capability"][number];
export type BriefActor = (typeof BRIEF_ACTORS)[number];

export interface BriefError {
  code: BriefErrorCode;
  /** JSON Pointer (RFC 6901) into the brief. */
  path: string;
  /** Russian message with the place in the brief («Сценарии, № 2, «Когда»: …»). */
  message_ru: string;
  allowed?: string[];
  hint?: string;
}

export type ValidateBriefResult = { ok: true; brief: SystemBrief } | { ok: false; errors: BriefError[] };

/** «Сценарии, № 2, «Когда»» for a zod path; empty for the root. */
function placeOf(path: readonly PropertyKey[]): string {
  const [field, ...rest] = path;
  if (typeof field !== "string") return "";
  const parts = [FIELD_LABELS[field as BriefField] ?? `«${field}»`];
  for (const seg of rest) {
    if (typeof seg === "number") parts.push(`№ ${seg + 1}`);
    else parts.push(`«${BRIEF_PROP_LABELS[String(seg)] ?? String(seg)}»`);
  }
  return parts.join(", ");
}

const lowerFirst = (s: string) => (s ? s[0]?.toLowerCase() + s.slice(1) : s);

/** Validates a brief: schema, limits, unique ids, goal references, size. Errors are Russian, with the place. */
export function validateBrief(input: unknown): ValidateBriefResult {
  const parsed = systemBriefSchema.safeParse(input);
  if (parsed.success) return { ok: true, brief: parsed.data };
  const errors = parsed.error.issues.flatMap((issue) => {
    const custom =
      issue.code === "custom"
        ? (issue.params as { briefCode?: BriefErrorCode } | undefined)?.briefCode
        : undefined;
    const place = placeOf(issue.path);
    return fromZodIssues([issue]).map((e): BriefError => {
      const code: BriefErrorCode = custom ?? (issue.code === "too_big" ? "LIMIT_EXCEEDED" : "SCHEMA_INVALID");
      const message = custom || !place ? e.message_ru : `${place}: ${lowerFirst(e.message_ru)}`;
      const out: BriefError = { code, path: e.path, message_ru: message };
      if (e.allowed) out.allowed = e.allowed;
      if (issue.code === "unrecognized_keys") out.hint = "Удалите свойство: в брифе такого поля нет";
      else if (e.hint) out.hint = e.hint;
      return out;
    });
  });
  return { ok: false, errors };
}

/** A brief with nothing filled yet (the interview starts from it). */
export function emptyBrief(): SystemBrief {
  return systemBriefSchema.parse({});
}
