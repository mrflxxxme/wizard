// QA prompts (agents/qa.yaml#checks.from_acceptance.scenario.prompt_inputs, #explain.step2_llm). DSL, rules and
// reference scenarios come from assets/qa.json (scripts/gen-qa-assets.mjs).
import type { AppSpec } from "@wizard/appspec";
import assets from "../../assets/qa.json" with { type: "json" };

export const QA_ASSETS = assets as {
  dsl: string;
  rules: string;
  categories: string[];
  explainRules: string;
  examples: string[];
};

export const GENERATE_SYSTEM = [
  "Ты — QA-агент Wizard. По критериям приёмки составь исполнимые сценарии проверки на DSL ниже и вызови submit_checks.",
  "На каждый критерий — минимум один сценарий с id SC-<AC id> (дополнительные: SC-<AC id>-2, …). Только сущности, поля, роли и функции из дайджеста.",
  "Данные — только синтетика: email user<N>@example.test, телефоны +7 999 000-XX-XX, имена вида «Участник N».",
  QA_ASSETS.dsl,
  QA_ASSETS.rules,
  "# Эталон 1",
  QA_ASSETS.examples[0],
  "# Эталон 2",
  QA_ASSETS.examples[1],
].join("\n\n");

export const EXPLAIN_SYSTEM = [
  "Ты — QA-агент Wizard. Для каждой упавшей проверки объясни строителю причину и исправление и вызови submit_explanations.",
  `Категории: ${QA_ASSETS.categories.join(", ")}.`,
  "fix.target — JSON Pointer спеки (/permissions/3) или путь файла (functions/x.ts). Тексты — по-русски, без значений персональных данных.",
  QA_ASSETS.explainRules,
].join("\n\n");

/** Arg names of a function from its v.* validators (best effort; the digest is a hint for the model). */
export function functionArgs(source: string | undefined): string[] {
  if (!source) return [];
  const m = /args\s*:\s*\{([\s\S]*?)\}\s*,\s*(?:handler|returns|\w+\s*:)/.exec(source);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*v\.(optional\(\s*v\.)?([a-zA-Z]+)/g)].map(
    (x) => `${x[1]}${x[2] ? "?" : ""}:${x[3]}`,
  );
}

/** Entities (fields with types, enum, required, limits, pii), roles, functions with args, workflows, connectors. */
export function qaDigest(spec: AppSpec, files?: ReadonlyMap<string, string>): string {
  const lines: string[] = [`Система: ${spec.app.name}`, "Роли:"];
  for (const r of spec.roles) lines.push(`- ${r.name} «${r.label}» ${r.access}${r.isAdmin ? " admin" : ""}`);
  lines.push("Сущности (поле:тип, ! — обязательно, [pii] — ПДн):");
  for (const e of spec.entities) {
    const fields = e.fields.map((f) => {
      let t = `${f.name}:${f.type === "ref" && f.ref ? `ref(${f.ref.entity})` : f.type}`;
      if (f.enum) t += `{${f.enum.map((o) => o.value).join("|")}}`;
      if (f.required) t += "!";
      if (f.unique) t += " unique";
      if (f.min !== undefined || f.max !== undefined) t += ` [${f.min ?? ""}..${f.max ?? ""}]`;
      if (f.maxLength) t += ` ≤${f.maxLength}`;
      if (f.pii && f.pii !== "none") t += ` [${f.pii}]`;
      return t;
    });
    lines.push(`- ${e.name} «${e.label}»: ${fields.join(", ")}`);
  }
  lines.push("Права:");
  for (const p of spec.permissions)
    lines.push(
      `- ${p.role}: ${p.entity} ${p.ops.join(",")}${p.rowFilter ? ` rowFilter ${JSON.stringify(p.rowFilter)}` : ""}`,
    );
  if (spec.functions?.length) {
    lines.push("Функции (имя kind [роли] (аргументы)):");
    for (const f of spec.functions) {
      const args = functionArgs(files?.get(f.file));
      lines.push(
        `- ${f.name} ${f.kind}${f.roles ? ` [${f.roles.join(",")}]` : ""}${args.length ? ` (${args.join(", ")})` : ""}`,
      );
    }
  }
  if (spec.workflows?.length)
    lines.push(
      "Автоматизации:",
      ...spec.workflows.map(
        (w) =>
          `- ${w.name}: ${w.trigger.type}${w.trigger.entity ? ` ${w.trigger.entity}` : ""} → ${w.steps.map((s) => s.type).join(", ")}`,
      ),
    );
  if (spec.integrations?.length)
    lines.push(`Подключения: ${spec.integrations.map((i) => `${i.name}(${i.connector})`).join(", ")}`);
  return lines.join("\n");
}
