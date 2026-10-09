// The reviewer of the techreview (V3-15, callType techreview — T0 only, data-boundary.yaml#call_types): a model of
// another family than the builder (models.yaml#routes.techreview, RouteInput.avoidFamilies) reads the system digest and
// answers with a closed set of findings — severity, area, an evidence reference and a fix kind (submit_techreview).
// A finding whose evidence the system does not have is dropped: the deterministic part is the source of truth.
import { CUSTOM_FUNCTIONS_DIR } from "@wizard/appspec";
import {
  type CallType,
  createRegistry,
  type LlmMessage,
  modelFamily,
  ROUTES,
  type RouteOutput,
} from "@wizard/llm";
import { z } from "zod";
import { callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool } from "../../../core/tool.js";
import { OWNER_INPUT_CHECKS } from "../../v2/blockers.js";
import type { TechDigest } from "./digest.js";
import {
  REVIEW_AREAS,
  REVIEW_SEVERITIES,
  type ReviewFinding,
  type TechCheck,
  type TechSystem,
} from "./types.js";

export const TECHREVIEW_CALL_TYPE = "techreview" satisfies CallType;
/** Most findings of one answer. */
export const MAX_FINDINGS = 12;
/** Largest function patch (G0 forbidden_api.limits: a function source ≤ 200 KB; a patch here is small). */
export const PATCH_MAX = 60_000;

const findingSchema = z.strictObject({
  severity: z.enum(REVIEW_SEVERITIES),
  area: z.enum(REVIEW_AREAS),
  title_ru: z.string().min(5).max(240),
  evidence: z.strictObject({
    kind: z.enum(["check", "spec", "file"]),
    ref: z.string().min(1).max(300),
  }),
  fix: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("function_patch"),
      file: z.string().min(1).max(300),
      source: z.string().min(20).max(PATCH_MAX),
    }),
    z.strictObject({ kind: z.literal("extension"), op: z.record(z.string(), z.unknown()) }),
  ]),
});

/** submit_techreview input: the findings of one review round (empty — nothing to fix). */
export const techreviewInputSchema = z.strictObject({
  findings: z.array(findingSchema).max(MAX_FINDINGS),
});
export type TechreviewInput = z.output<typeof techreviewInputSchema>;

export const submitTechreview = defineTool({
  name: "submit_techreview",
  description: "Findings of the technical review of the whole system (closed set).",
  input: techreviewInputSchema,
});

const ROLE = [
  "Ты — технический ревьюер собранной системы на платформе Wizard. Систему собрала модель другого семейства; ты проверяешь её целиком: данные, права, автоматизации и код функций, а не одну страницу.",
  "Источник истины — детерминированные проверки (checks): то, что они уже нашли, не повторяй без нового довода; пройденные проверки не оспаривай без конкретного места в системе.",
].join("\n");

const LOOK_FOR = [
  "data — связность данных между модулями: ссылки, статусы, цепочки «заявка → сделка → уведомление ответственному», «запись → напоминание», «выдача → статус предмета»",
  "permissions — права ролей шире нужного, rowFilter, скрытые поля, публичные функции",
  "errors — обработка ошибок в functions/custom/**: нет записи, null, повторный вызов, сбой внешнего сервиса",
  "edge_cases — пустые списки, повторная отправка формы, отмена, удаление связанной записи, часовой пояс",
  "chains, integrations, performance, accessibility — когда в сводке есть конкретная причина",
];

const RULES = [
  "У каждой находки — доказательство: evidence.kind=check и id проверки из checks; или kind=spec и JSON-указатель на часть системы (например /workflows/2 или /entities/0/fields/3); или kind=file и путь файла из сводки.",
  "severity: blocker — с этим систему нельзя публиковать (утечка данных, потеря записей, сломанная цепочка); major — заметная ошибка; minor — улучшение.",
  `fix.kind: function_patch — только файл ${CUSTOM_FUNCTIONS_DIR}** из раздела custom, полный новый текст файла; extension — одна операция расширения (add_field, add_entity, add_role, add_function, add_automation), она только добавляет; none — безопасного исправления нет.`,
  "Модули платформы и их файлы не меняются. Данных клиентов в сводке нет — не придумывай их.",
  "Данные оператора персональных данных (название, контакт, адрес, ИНН) вводит владелец перед публикацией — это не находка и не блокер сборки.",
  "Ответ — только вызов submit_techreview. Нечего исправлять — пустой список findings.",
];

/** Messages of one review round. */
export function techreviewMessages(digest: TechDigest, round: number, rounds: number): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Что искать",
        LOOK_FOR.map((x) => `- ${x}`).join("\n"),
        "## Правила",
        RULES.map((x) => `- ${x}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Раунд ${round} из ${rounds}`,
        round > 1
          ? "Исправления прошлого раунда — в applied, проверки пересчитаны. Найди то, что осталось."
          : "Первый просмотр системы.",
        "## Сводка системы",
        JSON.stringify(digest),
      ].join("\n\n"),
    },
  ];
}

/** Builder routes whose chain heads are the builder's families by default (models.yaml#routes.techreview note). */
const BUILDER_CALL_TYPES = ["page_compose", "signature_section", "art_direction"] as const;

/** Families of the heads of the builder routes (glm, kimi): the reviewer of a v3 build is never one of them. */
export function defaultBuilderFamilies(reg = createRegistry()): string[] {
  const out = new Set<string>();
  for (const ct of BUILDER_CALL_TYPES) {
    const chain = ROUTES[ct].chain;
    for (const id of [chain.T1?.[0], chain.T0?.[0]]) {
      const m = id ? reg.models.find((x) => x.id === id) : undefined;
      if (m) out.add(modelFamily(m));
    }
  }
  return [...out].sort();
}

/** Model family of a model id (null — not in the registry). */
export function familyOf(modelId: string, reg = createRegistry()): string | null {
  const m = reg.models.find((x) => x.id === modelId);
  return m ? modelFamily(m) : null;
}

/** Does a JSON pointer resolve in the value? */
export function resolves(value: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let cur: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur as object, key)) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return true;
}

/** Is the evidence of a finding in the system: a known check, a spec pointer, a file (path or path:line)? */
export function evidenceFound(
  f: Pick<ReviewFinding, "evidence">,
  system: TechSystem,
  checks: readonly TechCheck[],
): boolean {
  const { kind, ref } = f.evidence;
  if (kind === "check") return checks.some((c) => c.id === ref);
  if (kind === "spec") return resolves(system.spec, ref);
  return system.files.has(ref.replace(/:\d+$/, ""));
}

/** What the owner fills before publication, not the build: the personal data operator's name, contact, address, ИНН. */
const OWNER_INPUT_RE =
  /оператор\p{L}*\s+(?:обработки\s+)?(?:персональн|пдн)|(?:данн|сведени|реквизит|назван|контакт|адрес|инн)\p{L}*\s+(?:об\s+)?оператор/iu;

/**
 * A finding about the owner's input (G2-PII-06 and the operator fields of /compliance): the owner fills them before
 * publication (publish refuses without them), so they never block the build (builder.yaml#v2.stages.gates, B2-21).
 */
export function ownerInputFinding(f: Pick<ReviewFinding, "evidence" | "title_ru">): boolean {
  const { kind, ref } = f.evidence;
  if (kind === "check" && OWNER_INPUT_CHECKS.has(ref)) return true;
  if (kind === "spec" && /^\/compliance(?:\/operator|$)/.test(ref)) return true;
  return OWNER_INPUT_RE.test(f.title_ru);
}

/** One review round: the findings with valid evidence, the dropped count, the answer's model and cost. */
export async function reviewRound(o: {
  route: RouteFn;
  avoidFamilies: readonly string[];
  digest: TechDigest;
  round: number;
  rounds: number;
  system: TechSystem;
  checks: readonly TechCheck[];
  signal?: AbortSignal;
}): Promise<{
  /** false — no valid submit_techreview after the repair. */
  valid: boolean;
  findings: ReviewFinding[];
  unfounded: number;
  /** Findings about the owner's input (ownerInputFinding): not the build's, publication asks the owner for them. */
  ownerInput: ReviewFinding[];
  model: string | null;
  calls: number;
  creditsMilli: number;
}> {
  let model: string | null = null;
  let creditsMilli = 0;
  let calls = 0;
  // The reviewer is of another family than the builder: the router skips those families of the chain.
  const route: RouteFn = async (input) => {
    calls += 1;
    const out: RouteOutput = await o.route({ ...input, avoidFamilies: [...o.avoidFamilies] });
    model = out.model;
    creditsMilli += out.creditsMilli;
    return out;
  };
  const r = await callTool({
    route,
    callType: TECHREVIEW_CALL_TYPE,
    orgPolicy: null,
    ctx: { orgId: "host" },
    ...(o.signal ? { signal: o.signal } : {}),
    stepName: `techreview_${o.round}`,
    messages: techreviewMessages(o.digest, o.round, o.rounds),
    tool: submitTechreview,
    // Shape probe 2026-10-09 (v3-004): gpt-oss-120b sometimes slips a field of the findings — a second repair is
    // cheap (≈ 0.1 ₽); a model that writes the arguments as JSON text instead of the call is taken as the call.
    maxRepairs: 2,
    textArgs: true,
  });
  if (!r.ok) return { valid: false, findings: [], unfounded: 0, ownerInput: [], model, calls, creditsMilli };
  const all = r.value.findings.map((f, i): ReviewFinding => ({ ...f, id: `r${o.round}-${i + 1}` }));
  const founded = all.filter((f) => evidenceFound(f, o.system, o.checks));
  const ownerInput = founded.filter(ownerInputFinding);
  const findings = founded.filter((f) => !ownerInputFinding(f));
  return {
    valid: true,
    findings,
    unfounded: all.length - founded.length,
    ownerInput,
    model,
    calls,
    creditsMilli,
  };
}
