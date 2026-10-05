// Builder prompts: static system prefix (same for every run), session message, phase instructions.

import type { AppSpec } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { gapsPromptSection } from "../gaps.js";
import { textRulesSection } from "../text-rules.js";
import { cardDigest, fileTree, specDigest } from "./digest.js";
import { capabilityToc, PROMPT_PARTS, uiKitDocs } from "./docs.js";
import type { PlanStep } from "./tools.js";
import type { BuildCard } from "./types.js";

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
  "# Semantic rules",
  PROMPT_PARTS.semantic,
  "",
  "# Code conventions",
  PROMPT_PARTS.conventions,
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
    `Фаза ops: примени план через apply_ops батчами до 50 операций; текущая версия спеки — ${version}. set_acceptance — список из карточки 1:1. Когда все ops-шаги выполнены, ответь коротким итогом без вызова инструментов.`,
  code: () =>
    "Фаза code: запиши файлы через write_file — сначала functions/**, затем ui/**; после каждых ≤ 6 файлов запускай run_gate G0. Когда код готов, ответь коротким итогом без вызова инструментов.",
  change: (version: number) =>
    `Правка готовой системы по карточке изменений; текущая версия спеки — ${version}. Меняй спеку через apply_ops и файлы через write_file. Когда закончишь, ответь коротким итогом без вызова инструментов.`,
  pointEdit: (file: string, instruction: string) =>
    `Правка по клику: меняй только файл ${file}. Задача: ${instruction}. Нужна правка данных или прав — ask_orchestrator. Когда закончишь, ответь без вызова инструментов.`,
  escalationRephrase: (text: string) => `Пользователь объяснил по-другому: ${text}`,
  simplify: () =>
    "Пользователь выбрал «Упростить»: удали упавшую функцию или экран (remove_function/remove_page) и связанные с ними критерии приёмки, остальное не трогай. Затем ответь без вызова инструментов.",
  retry: () => "Попробуй ещё раз: исправь упавшие проверки другим способом.",
};

export function gateReportText(report: GateReport, explanations?: unknown[]): string {
  const failed = report.checks.filter((c) => c.status === "fail" || c.status === "error");
  const lines = [
    `Отчёт проверок ${report.level}: ${report.passed ? "пройдено" : `упало ${failed.length}`}.`,
    ...failed
      .slice(0, 20)
      .map(
        (c) =>
          `- ${c.id}${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : ""}${c.path ? ` ${c.path}` : ""}: ${c.message_ru}${c.fixHint ? ` (подсказка: ${c.fixHint})` : ""}`,
      ),
  ];
  if (explanations?.length)
    lines.push("Объяснения QA:", ...explanations.map((e) => `- ${JSON.stringify(e)}`));
  lines.push("Исправь через apply_ops/write_file и ответь без вызова инструментов.");
  return lines.join("\n");
}
