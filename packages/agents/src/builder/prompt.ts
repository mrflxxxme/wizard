// Builder prompts: static system prefix (same for every run), session message, phase instructions.

import type { AppSpec } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { PAGE_STUB_MARKER } from "@wizard/gates";
import { gapsPromptSection } from "../gaps.js";
import { textRulesSection } from "../text-rules.js";
import { cardDigest, fileTree, specDigest } from "./digest.js";
import { capabilityToc, PROMPT_PARTS, uiKitDocs } from "./docs.js";
import { specShapes } from "./shapes.js";
import type { PlanStep } from "./tools.js";
import type { BuildCard } from "./types.js";

/** First line of a page scaffold (builder.ts): the file still waits for the model's full text. */
export const STUB_MARKER = PAGE_STUB_MARKER;

export const STATIC_PROMPT = [
  "You are the Wizard builder. You turn an approved system card into an AppSpec (via apply_ops) and code of",
  "the system (via write_file): React pages in ui/** on @wizard/ui-kit and server functions in functions/** on",
  "@wizard/sdk. All user-visible text is Russian. Finish a phase by answering without tool calls.",
  "Tool errors come back as structured results {ok:false, error:{code, message, issues}}: fix and retry.",
  "Never weaken acceptance criteria or widen role permissions beyond the card. Owner-only compliance fields",
  "(operator*, consentText, retentionWaiver) are not yours: use consentTemplateId and policyPage only.",
  "",
  "# Phases",
  PROMPT_PARTS.phases,
  "",
  "# AppSpec operations (apply_ops)",
  PROMPT_PARTS.ops,
  "",
  specShapes(),
  "",
  "# Semantic rules",
  PROMPT_PARTS.semantic,
  "",
  "# Code conventions",
  PROMPT_PARTS.conventions,
  "",
  "# @wizard/sdk: шпаргалка (точный API; другого нет)",
  PROMPT_PARTS.sdk,
  "",
  uiKitDocs().docs,
  "",
  "# Recipes (get_capability({id}) before planning; a recipe is a quality hint, the card decides what to build)",
  capabilityToc(),
  "",
  "# Тексты для людей (страницы, письма, подписи внутри системы)",
  textRulesSection("system"),
  "",
  "# Чего платформа пока не умеет (честно: чего нет → замена)",
  gapsPromptSection("build"),
].join("\n");

export function sessionMessage(a: {
  card: BuildCard;
  spec: AppSpec;
  files: { path: string; bytes: number }[];
  plan: PlanStep[] | null;
}): string {
  const parts = [
    cardDigest(a.card),
    "",
    "Текущая спека:",
    specDigest(a.spec),
    "",
    "Файлы:",
    fileTree(a.files),
  ];
  if (a.plan)
    parts.push(
      "",
      "План:",
      ...a.plan.map(
        (s) =>
          `- ${s.id} ${s.kind}: ${s.title} → ${s.targets.join(", ")}${s.acRefs.length ? ` (${s.acRefs.join(", ")})` : ""}`,
      ),
    );
  return parts.join("\n");
}

export const PHASE_TEXT = {
  plan: (title: string) =>
    `Карточка «${title}» утверждена. Составь план сборки вызовом submit_plan: шаги ops (роли → сущности → права → автоматизации → подключения → объявления функций и экранов → критерии приёмки → compliance), затем code (functions/**, потом ui/**).`,
  ops: (version: number) =>
    `Фаза ops: собери спеку системы по карточке через apply_ops; текущая версия спеки — ${version}. Порядок операций: роли → сущности с полями, индексами и сроком хранения → права ролей на сущности → подключения → автоматизации → объявления функций и страниц (файлы functions/<имя>.ts и ui/pages/<Имя>.tsx) → set_acceptance (список из карточки 1:1) → set_compliance (consentTemplateId, policyPage). Запись на время: услуги (и мастера) — витрина с read посетителю; запись — create посетителю, поля ref на услугу (и мастера), starts_at типа datetime, status enum (новая → подтверждена → отменена); «одно время — одна запись» — уникальный индекс по (мастер, starts_at) или по starts_at, без функции; напоминание — автоматизация trigger schedule relative по starts_at с notify; отмену делает сотрудник в кабинете. Операции батча применяются по порядку, поэтому ссылки на объявленное выше в том же батче работают. Обычно хватает 2–3 батчей до 50 операций; формы объектов — в разделе «Точные формы объектов». Батч с ошибкой не применяется целиком — исправь операции из списка ошибок и отправь батч снова целиком. Когда спека собрана, ответь коротким итогом без вызова инструментов.`,
  /** Harness v2, single pipeline keeps the plan-driven text. */
  opsTemplate: (version: number) =>
    `Фаза ops (шаблон): собери спеку системы по карточке через apply_ops; текущая версия спеки — ${version}. Экраны системы соберёт шаблон: страницы и серверные функции НЕ объявляй. Порядок операций: роли (публичная роль посетителя, если в карточке есть форма или витрина, и роли со входом) → сущности с полями, индексами и сроком хранения (у заявки — поле status типа enum) → права ролей на сущности (посетителю — create заявки и read витрины, сотрудникам — read/update/delete) → подключения → автоматизации (только шаги notify/update/create — формат: get_capability notify) → set_acceptance (список из карточки 1:1) → set_compliance (consentTemplateId, policyPage). Операции батча применяются по порядку; обычно хватает 2–3 батчей. Батч с ошибкой не применяется целиком — исправь операции из списка ошибок и отправь батч снова. Когда спека собрана, ответь коротким итогом без вызова инструментов.`,
  opsFromPlan: (version: number) =>
    `Фаза ops: примени план через apply_ops батчами до 50 операций; текущая версия спеки — ${version}. set_acceptance — список из карточки 1:1. Когда все ops-шаги выполнены, ответь коротким итогом без вызова инструментов.`,
  code: (stubs: readonly string[] = []) =>
    [
      "Фаза code: запиши файлы через write_file — сначала все функции functions/** (форма — по шпаргалке @wizard/sdk), затем каждую страницу ui/**.",
      stubs.length
        ? `Заготовки страниц из спеки уже созданы (строка ${STUB_MARKER}); перепиши каждую целиком: ${stubs.join(", ")}.`
        : "",
      "run_gate G0 запускай, когда записаны все функции и все страницы: не застревай на исправлениях раньше. Когда код готов, ответь коротким итогом без вызова инструментов.",
    ]
      .filter(Boolean)
      .join(" "),
  stubs: (stubs: readonly string[]) =>
    `Остались незаполненные заготовки страниц (строка ${STUB_MARKER}): ${stubs.join(", ")}. Перепиши каждую целиком через write_file по карточке и спеке, затем ответь без вызова инструментов.`,
  change: (version: number) =>
    `Правка готовой системы по карточке изменений; текущая версия спеки — ${version}. Меняй спеку через apply_ops и файлы через write_file. Когда закончишь, ответь коротким итогом без вызова инструментов.`,
  pointEdit: (file: string, instruction: string) =>
    `Правка по клику: меняй только файл ${file}. Задача: ${instruction}. Нужна правка данных или прав — ask_orchestrator. Когда закончишь, ответь без вызова инструментов.`,
  escalationRephrase: (text: string) => `Пользователь объяснил по-другому: ${text}`,
  simplify: () =>
    "Пользователь выбрал «Упростить»: удали упавшую функцию или экран (remove_function/remove_page) и связанные с ними критерии приёмки, остальное не трогай. Затем ответь без вызова инструментов.",
  retry: () => "Попробуй ещё раз: исправь упавшие проверки другим способом.",
};

/** Checks whose failures usually mean the model guessed the SDK API. */
const SDK_CHECKS = new Set(["G0-TS-01", "G0-FN-01"]);

/** Fix-round reminder of the exact SDK API (the full cheatsheet is in the static prompt). */
export const SDK_FIX_HINT =
  'Ошибки типов и объявлений функций — сверься со шпаргалкой @wizard/sdk из системного промпта: импорт только `import { query, mutation, action, v } from "@wizard/sdk"`; `export default query({ args: { x: v.string(), y: v.optional(v.int()) }, handler: async (ctx, args) => … })` без аннотаций параметров; необязательный аргумент — v.optional(v.X()), а не .optional(); таблицы — ctx.db.<сущность>.get/getBy/list/first/count/paginate/insert/patch/delete, а не ctx.db.query(…). Строку из формы или адреса в аргумент v.id("x") передавай как `value as Id<"x">` (`import type { Id } from "@wizard/sdk"`). Одна функция — один тип результата: не возвращай из одной query разные формы в зависимости от аргументов, сделай отдельные функции.';

/** The check's evidence (the compiler's text for G0-TS-01, expected vs got for scenarios) on one line, ≤ 300 chars. */
export function evidenceOf(c: { evidence?: string }): string {
  const e = (c.evidence ?? "").replace(/\s+/g, " ").trim();
  if (!e) return "";
  if (e.startsWith("check_invalid"))
    return " — сценарий проверки с ошибкой составил QA, это не ошибка системы: спеку, критерии и код ради него не меняй";
  return ` — ${e.length > 300 ? `${e.slice(0, 299)}…` : e}`;
}

export function gateReportText(report: GateReport, explanations?: unknown[]): string {
  const failed = report.checks.filter((c) => c.status === "fail" || c.status === "error");
  const lines = [
    `Отчёт проверок ${report.level}: ${report.passed ? "пройдено" : `упало ${failed.length}`}.`,
    ...failed
      .slice(0, 20)
      .map(
        (c) =>
          `- ${c.id}${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : ""}${c.path ? ` ${c.path}` : ""}: ${c.message_ru}${evidenceOf(c)}${c.fixHint ? ` (подсказка: ${c.fixHint})` : ""}`,
      ),
  ];
  if (explanations?.length)
    lines.push("Объяснения QA:", ...explanations.map((e) => `- ${JSON.stringify(e)}`));
  if (failed.some((c) => SDK_CHECKS.has(c.id))) lines.push(SDK_FIX_HINT);
  lines.push("Исправь через apply_ops/write_file и ответь без вызова инструментов.");
  return lines.join("\n");
}
