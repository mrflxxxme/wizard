// Compact texts for the builder context (agents/builder.yaml#context.spec_digest) and the masked spec.json (L3-06).
import type { AppSpec } from "@wizard/appspec";
import { CAPABILITY_IDS } from "./docs.js";
import type { BuildCard } from "./types.js";

export const OPERATOR_MASK = "[ОПЕРАТОР]";
export const HIDDEN_MASK = "[СКРЫТО]";

/** spec.json for read_file: owner-only compliance values are masked, the rest is returned as is. */
export function maskSpec(spec: AppSpec): AppSpec {
  const out = structuredClone(spec);
  const c = out.compliance;
  if (c) {
    for (const k of ["operatorName", "operatorContact", "operatorInn", "operatorAddress"] as const)
      if (c[k] !== undefined) c[k] = OPERATOR_MASK;
    if (c.consentText !== undefined) c.consentText = HIDDEN_MASK;
    if (c.retentionWaiver) c.retentionWaiver = { reason: HIDDEN_MASK };
  }
  return out;
}

/** Entities, roles, permissions, pages, functions, AC — without operator fields, consentText and retentionWaiver. */
export function specDigest(spec: AppSpec): string {
  const lines: string[] = [`Система: ${spec.app.name}`];
  if (spec.roles.length)
    lines.push(
      "Роли:",
      ...spec.roles.map(
        (r) =>
          `- ${r.name} «${r.label}» ${r.access}${r.loginMethods ? ` [${r.loginMethods.join(",")}]` : ""}${r.isAdmin ? " admin" : ""}${r.selfSignup ? " selfSignup" : ""}`,
      ),
    );
  if (spec.entities.length)
    lines.push(
      "Сущности:",
      ...spec.entities.map((e) => {
        const fields = e.fields.map((f) => {
          let t = `${f.name}:${f.type === "ref" && f.ref ? `ref(${f.ref.entity})` : f.type}`;
          if (f.required) t += "!";
          if (f.pii && f.pii !== "none") t += `[${f.pii}]`;
          return t;
        });
        const idx = (e.indexes ?? []).map((i) => `(${i.fields.join(",")})`).join(" ");
        return `- ${e.name} «${e.label}»: ${fields.join(", ")}${idx ? ` индексы ${idx}` : ""}`;
      }),
    );
  if (spec.permissions.length)
    lines.push(
      "Права:",
      ...spec.permissions.map((p) => {
        const rf = p.rowFilter
          ? ` [${JSON.stringify(p.rowFilter)}${p.rowFilterOps ? ` на ${p.rowFilterOps.join(",")}` : ""}]`
          : "";
        return `- ${p.role}: ${p.entity} ${p.ops.join(",")}${rf}`;
      }),
    );
  if (spec.workflows?.length) lines.push(`Автоматизации: ${spec.workflows.map((w) => w.name).join(", ")}`);
  if (spec.integrations?.length)
    lines.push(`Подключения: ${spec.integrations.map((i) => `${i.name}(${i.connector})`).join(", ")}`);
  if (spec.functions?.length)
    lines.push(
      "Функции:",
      ...spec.functions.map(
        (f) => `- ${f.name} ${f.kind} ${f.file}${f.roles ? ` [${f.roles.join(",")}]` : ""}`,
      ),
    );
  if (spec.pages?.length)
    lines.push(
      "Страницы:",
      ...spec.pages.map((p) => `- ${p.route} «${p.title}» ${p.file} [${p.roles.join(",")}]`),
    );
  if (spec.acceptance?.length)
    lines.push("Критерии приёмки:", ...spec.acceptance.map((a) => `- ${a.id} ${a.check.type}: ${a.text}`));
  return lines.join("\n");
}

/** Compressed card for the session message. */
export function cardDigest(card: BuildCard): string {
  const lines: string[] = [];
  if (card.title) lines.push(`Карточка: «${card.title}»${card.summary ? ` — ${card.summary}` : ""}`);
  lines.push(
    "Роли:",
    ...card.roles.map((r) => `- ${r.name} «${r.label}» ${r.access}: ${(r.can ?? []).join("; ")}`),
  );
  if (card.data?.length)
    lines.push(
      "Данные:",
      ...card.data.map(
        (d) =>
          `- ${d.name} «${d.label}»: ${d.fields.map((f) => `${f.label}:${f.kind}`).join(", ")}${d.pii !== "none" ? " [ПДн]" : ""}`,
      ),
    );
  if (card.screens?.length)
    lines.push(
      "Экраны:",
      ...card.screens.map((s) => `- ${s.route} «${s.title}» [${s.roles.join(",")}]: ${s.purpose}`),
    );
  if (card.integrations?.length)
    lines.push(`Подключения: ${card.integrations.map((i) => `${i.connector} — ${i.purpose}`).join("; ")}`);
  if (card.automations?.length)
    lines.push("Автоматизации:", ...card.automations.map((a) => `- ${a.name}: ${a.when} → ${a.then}`));
  lines.push(
    "Критерии приёмки (менять и ослаблять нельзя):",
    ...card.acceptance.map((a) => `- ${a.id} ${JSON.stringify(a.check)}: ${a.text}`),
  );
  if (card.pii?.retention?.length)
    lines.push(
      `Хранение ПДн: ${card.pii.retention.map((r) => `${r.entity} ${r.deleteAfterDays} дн. (${r.mode})`).join("; ")}`,
    );
  if (card.assumptions?.length) lines.push("Допущения:", ...card.assumptions.map((a) => `- ${a}`));
  if (card.outOfScope?.length)
    lines.push("Не войдёт (не собирать):", ...card.outOfScope.map((a) => `- ${a}`));
  const recipe = card.segment && CAPABILITY_IDS.includes(card.segment) ? card.segment : "general";
  if (CAPABILITY_IDS.includes(recipe)) lines.push(`Рецепт: get_capability({id: "${recipe}"})`);
  return lines.join("\n");
}

export function fileTree(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return "Файлов пока нет.";
  return files.map((f) => `- ${f.path} (${f.bytes} Б)`).join("\n");
}
