// Message templates of notify steps and email templates: placeholder resolution against the spec (G0 PII rules,
// connector-interface.md §4; G2-TG-01 in M2) and rendering with record values.
import { type AppSpec, type Entity, SYSTEM_FIELDS, USERS_ENTITY, type Workflow } from "@wizard/appspec";
import { detect } from "@wizard/pii";
import { entityOf, fieldOf, placeholders } from "./spec-util.js";
import type { SpecIssue } from "./types.js";

export const LINK_PLACEHOLDER = "link";
const RECORD_REF = /^\$record\.([a-z][a-z0-9_]*)$/;

export interface PlaceholderInfo {
  /** Resolves to a field with pii ≠ none (or to the users entity: contacts and names). */
  pii: boolean;
  /** The field exists (always true when no entity is known). */
  known: boolean;
}

const isPii = (p: string | undefined) => p !== undefined && p !== "none";

/**
 * `{{field}}`, `{{ref.field}}` or `{{link}}` against `entity`; without an entity (template used from code) a name
 * counts as PII when any entity has a PII field with that name.
 */
export function resolvePlaceholder(spec: AppSpec, entity: Entity | undefined, name: string): PlaceholderInfo {
  if (name === LINK_PLACEHOLDER) return { pii: false, known: true };
  const [head, tail, ...rest] = name.split(".") as [string, string | undefined, ...string[]];
  if (!entity) {
    const last = tail ?? head;
    const pii = spec.entities.some((e) => isPii(fieldOf(e, last)?.pii));
    return { pii, known: true };
  }
  if ((SYSTEM_FIELDS as readonly string[]).includes(head) && tail === undefined)
    return { pii: false, known: true };
  const f = fieldOf(entity, head);
  if (!f) return { pii: false, known: false };
  if (tail === undefined) return { pii: isPii(f.pii), known: true };
  if (f.type !== "ref" || !f.ref || rest.length > 0) return { pii: false, known: false };
  if (f.ref.entity === USERS_ENTITY) return { pii: true, known: true };
  const target = entityOf(spec, f.ref.entity);
  const tf = target ? fieldOf(target, tail) : undefined;
  if (!tf) return { pii: false, known: (SYSTEM_FIELDS as readonly string[]).includes(tail) };
  return { pii: isPii(tf.pii), known: true };
}

export interface NotifyStepRef {
  workflow: Workflow;
  wi: number;
  si: number;
  params: Record<string, unknown>;
  entity: Entity | undefined;
}

/** notify steps of all workflows addressed to integration `name`. */
export function notifySteps(spec: AppSpec, name: string): NotifyStepRef[] {
  const out: NotifyStepRef[] = [];
  (spec.workflows ?? []).forEach((w, wi) => {
    w.steps.forEach((s, si) => {
      const params = (s.params ?? {}) as Record<string, unknown>;
      if (s.type !== "notify" || params.integration !== name) return;
      const entity = w.trigger.entity ? entityOf(spec, w.trigger.entity) : undefined;
      out.push({ workflow: w, wi, si, params, entity });
    });
  });
  return out;
}

/** Field of `$record.<field>` in a notify `to`, or null. */
export function recordField(to: unknown): string | null {
  const m = typeof to === "string" ? RECORD_REF.exec(to) : null;
  return m ? (m[1] as string) : null;
}

/** Recipient rule shared by email and Telegram: `to` is `$record.<ref to users>`. */
export function checkRecipient(step: NotifyStepRef, connector: string): SpecIssue[] {
  const path = `/workflows/${step.wi}/steps/${step.si}/params/to`;
  const field = recordField(step.params.to);
  const f = field && step.entity ? fieldOf(step.entity, field) : undefined;
  if (field && (!step.entity || (f?.type === "ref" && f.ref?.entity === USERS_ENTITY))) return [];
  return [
    {
      code: "CONFIG_INVALID",
      path,
      message_ru: "Получатель уведомления — поле записи со ссылкой на пользователя: $record.<поле>",
      rule: `${connector}.notify_recipient`,
    },
  ];
}

/** G0 for a Telegram text template: no PII placeholders (G2-TG-01), known fields, no PII in the literal text. */
export function checkTelegramText(spec: AppSpec, step: NotifyStepRef): SpecIssue[] {
  const path = `/workflows/${step.wi}/steps/${step.si}/params/text`;
  const text = step.params.text;
  if (typeof text !== "string" || text.trim() === "") {
    return [
      {
        code: "CONFIG_INVALID",
        path,
        message_ru: "У уведомления Telegram нет текста",
        rule: "telegram.notify_text",
      },
    ];
  }
  const issues: SpecIssue[] = [];
  for (const p of new Set(placeholders(text))) {
    const r = resolvePlaceholder(spec, step.entity, p);
    if (r.pii) {
      issues.push({
        code: "CONFIG_INVALID",
        path,
        message_ru: `Шаблон Telegram подставляет персональные данные «{{${p}}}» — в сообщениях Telegram ПДн запрещены`,
        rule: "G2-TG-01",
      });
    } else if (!r.known) {
      issues.push({
        code: "CONFIG_INVALID",
        path,
        message_ru: `Поле «${p}» для шаблона не найдено в сущности «${step.entity?.name ?? ""}»`,
        rule: "telegram.template_field",
      });
    }
  }
  const literal = text.replace(/\{\{[^}]*\}\}/g, " ");
  if (detect(literal).length > 0) {
    issues.push({
      code: "CONFIG_INVALID",
      path,
      message_ru: "В тексте уведомления Telegram есть персональные данные — уберите их",
      rule: "G2-TG-01",
    });
  }
  return issues;
}

/** `{{name}}` → esc(values[name]); unknown names → empty string. */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
  esc: (s: string) => string = (s) => s,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, k: string) =>
    Object.hasOwn(values, k) ? esc(String(values[k])) : "",
  );
}
