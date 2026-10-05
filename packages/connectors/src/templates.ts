// Message templates of notify steps and email templates: placeholder resolution against the spec (G0 PII rules,
// connector-interface.md §4; G2-TG-01 in M2) and rendering with record values.
import { type AppSpec, type Entity, SYSTEM_FIELDS, USERS_ENTITY, type Workflow } from "@wizard/appspec";
import { detect } from "@wizard/pii";
import { entityOf, fieldOf, placeholders } from "./spec-util.js";
import type { SpecIssue } from "./types.js";

export const LINK_PLACEHOLDER = "link";
/** M2-50: signed one-time links of visitor messages (rendered by the host, never PII). */
export const CANCEL_LINK_PLACEHOLDER = "cancel_link";
export const UNSUBSCRIBE_LINK_PLACEHOLDER = "unsubscribe_link";
const LINK_PLACEHOLDERS = new Set([LINK_PLACEHOLDER, CANCEL_LINK_PLACEHOLDER, UNSUBSCRIBE_LINK_PLACEHOLDER]);
const RECORD_REF = /^\$record\.([a-z][a-z0-9_]*)$/;
const ROLE_REF = /^\$role:([a-z][a-z0-9_]*)$/;
export const OWNER_REF = "$owner";

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
  if (LINK_PLACEHOLDERS.has(name)) return { pii: false, known: true };
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

/** One recipient of a notify step (runtime.yaml#workflows.step_params, M2-50). */
export type RecipientRef =
  | { kind: "record"; field: string }
  | { kind: "owner" }
  | { kind: "role"; role: string };

/** `to`: `$record.<field>` | `$owner` | `$role:<role>` or a list of them (1…5); null — malformed. */
export function parseRecipients(to: unknown): RecipientRef[] | null {
  const list = Array.isArray(to) ? to : [to];
  if (list.length === 0 || list.length > 5) return null;
  const out: RecipientRef[] = [];
  for (const t of list) {
    if (typeof t !== "string") return null;
    const field = recordField(t);
    const role = ROLE_REF.exec(t)?.[1];
    if (field) out.push({ kind: "record", field });
    else if (t === OWNER_REF) out.push({ kind: "owner" });
    else if (role) out.push({ kind: "role", role });
    else return null;
  }
  return out;
}

/** What a `$record.<field>` recipient is: a user of the system (ref to users) or a visitor contact (email field). */
export function recordRecipientKind(entity: Entity | undefined, field: string): "user" | "visitor" | null {
  if (!entity) return "user";
  const f = fieldOf(entity, field);
  if (f?.type === "ref" && f.ref?.entity === USERS_ENTITY) return "user";
  if (f?.type === "email") return "visitor";
  return null;
}

/**
 * Recipient rules shared by email and Telegram (M2-50): `$record.<ref to users>`, `$owner`, `$role:<login role>`;
 * email also `$record.<email field>` of a visitor without an account — only with `consentField` (bool field of the
 * record that the form's separate unchecked checkbox fills). Telegram goes to users of the system only.
 */
export function checkRecipient(spec: AppSpec, step: NotifyStepRef, connector: string): SpecIssue[] {
  const path = `/workflows/${step.wi}/steps/${step.si}/params/to`;
  const consentPath = `/workflows/${step.wi}/steps/${step.si}/params/consentField`;
  const issue = (message_ru: string, rule = `${connector}.notify_recipient`, at = path): SpecIssue => ({
    code: "CONFIG_INVALID",
    path: at,
    message_ru,
    rule,
  });
  const list = parseRecipients(step.params.to);
  if (!list) {
    return [
      issue(
        "Получатель уведомления: $owner (владелец системы), $role:<роль>, $record.<поле со ссылкой на пользователя> или $record.<поле email посетителя>",
      ),
    ];
  }
  const out: SpecIssue[] = [];
  for (const r of list) {
    if (r.kind === "owner") continue;
    if (r.kind === "role") {
      const role = spec.roles.find((x) => x.name === r.role);
      if (role?.access !== "login")
        out.push(
          issue(
            `Роль «${r.role}» не найдена среди ролей со входом — уведомить можно только сотрудников с аккаунтом`,
          ),
        );
      continue;
    }
    const kind = recordRecipientKind(step.entity, r.field);
    if (kind === null) {
      out.push(
        issue(
          `Поле «${r.field}» — не ссылка на пользователя и не email: такому получателю сообщение не отправить`,
        ),
      );
    } else if (kind === "visitor") {
      if (connector !== "email") {
        out.push(
          issue("Посетителю без аккаунта уходят только письма: Telegram — сотрудникам с привязанным чатом"),
        );
        continue;
      }
      const consent = step.params.consentField;
      const cf = typeof consent === "string" ? fieldOf(step.entity, consent) : undefined;
      if (cf?.type !== "bool")
        out.push(
          issue(
            "Письмо посетителю уходит только с его согласия: укажите consentField — поле «да/нет» записи, которое форма заполняет отдельной неотмеченной галочкой «Согласен получать служебные сообщения»",
            "notify.visitor_consent",
            consentPath,
          ),
        );
    }
  }
  return out;
}

/** Kinds of the step's recipients: staff (owner, role), the record's owner user, other users, visitors. */
export function recipientKinds(step: NotifyStepRef): Set<"staff" | "record_owner" | "user" | "visitor"> {
  const out = new Set<"staff" | "record_owner" | "user" | "visitor">();
  for (const r of parseRecipients(step.params.to) ?? []) {
    if (r.kind !== "record") out.add("staff");
    else if (recordRecipientKind(step.entity, r.field) === "visitor") out.add("visitor");
    else if (step.entity?.ownerField && r.field === step.entity.ownerField) out.add("record_owner");
    else out.add("user");
  }
  return out;
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
