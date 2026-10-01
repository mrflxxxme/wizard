// Policy page and consent text of a system (security/compliance.yaml#system_package.policy_page, #consent.text):
// a lawyer's template (templates.ts) plus facts taken from the spec — operator, purposes, data categories, actions,
// retention, processors (subprocessors_of_system) and the withdrawal procedure. No legal wording lives here.
import { createHash } from "node:crypto";
import type { AppSpec, Entity, Field } from "@wizard/appspec";
import { fillTemplate, type LegalTemplates } from "./templates.js";

/** Default route of the policy page (compliance.policyPage). */
export const DEFAULT_POLICY_PAGE = "/privacy";
/** Page of a logged-in user: consent withdrawal (runtime.yaml#service_endpoints.privacy). */
export const PRIVACY_PAGE = "/_wizard/privacy";
/** Login data of end users is anonymized after this many days without a login (compliance.yaml#retention.users). */
export const USERS_RETENTION_DAYS = 3 * 365;

const NOT_SET = "[не указано владельцем системы]";

export const fieldPii = (f: Field) => f.pii ?? (f.type === "file" ? "basic" : "none");
export const piiFieldsOf = (e: Entity): Field[] => e.fields.filter((f) => fieldPii(f) !== "none");

/** compliance.yaml#system_package.applies_when */
export function packageApplies(spec: AppSpec): boolean {
  return spec.roles.some((r) => r.access === "login") || spec.entities.some((e) => piiFieldsOf(e).length > 0);
}

/** compliance.policyPage, else /privacy when the package applies and no page of the spec takes the route. */
export function effectivePolicyPage(spec: AppSpec): string | null {
  const own = spec.compliance?.policyPage;
  if (own) return own;
  if (!packageApplies(spec)) return null;
  return (spec.pages ?? []).some((p) => p.route === DEFAULT_POLICY_PAGE) ? null : DEFAULT_POLICY_PAGE;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const list = (items: string[], empty: string) =>
  (items.length ? items : [empty]).map((s) => `- ${oneLine(s)}`).join("\n");

function loginMethods(spec: AppSpec): Set<string> {
  return new Set(spec.roles.filter((r) => r.access === "login").flatMap((r) => r.loginMethods ?? []));
}

/** Login data kept in `users` (runtime.yaml#postgres.system_tables.users). */
function loginData(spec: AppSpec): string[] {
  if (!spec.roles.some((r) => r.access === "login")) return [];
  const m = loginMethods(spec);
  return [
    "имя",
    ...(m.has("email_otp") ? ["email"] : []),
    ...(m.has("phone_otp") || m.has("telegram") ? ["телефон"] : []),
    ...(m.has("telegram") ? ["аккаунт Telegram"] : []),
  ];
}

const connectors = (spec: AppSpec) => new Set((spec.integrations ?? []).map((i) => i.connector));

/** compliance.yaml#system_package.policy_page.subprocessors_of_system: derived from integrations and login methods. */
export function systemProcessors(spec: AppSpec): { name: string; purpose: string }[] {
  const c = connectors(spec);
  const m = loginMethods(spec);
  const out = [
    { name: "Wizard", purpose: "обработчик по поручению оператора: хостинг и работа системы" },
    { name: "Облачные технологии (Cloud.ru)", purpose: "хостинг и хранение данных в РФ" },
  ];
  if (c.has("yookassa"))
    out.push({
      name: "ЮKassa (ООО НКО «ЮМани»)",
      purpose: "приём платежей и чеки (email или телефон для чека)",
    });
  if (m.has("email_otp") || c.has("email"))
    out.push({ name: "Почтовый провайдер (РФ)", purpose: "отправка кодов входа и уведомлений по email" });
  if (m.has("phone_otp")) out.push({ name: "SMS-провайдер (РФ)", purpose: "отправка кодов входа по SMS" });
  if (m.has("telegram") || c.has("telegram"))
    out.push({ name: "Telegram", purpose: "вход и уведомления (аккаунт и chat_id Telegram)" });
  return out;
}

const OP_LABELS: Record<string, string> = {
  create: "сбор и запись",
  read: "просмотр",
  update: "изменение",
  delete: "удаление",
};

function roleLabel(spec: AppSpec, name: string): string {
  return spec.roles.find((r) => r.name === name)?.label ?? name;
}

function fieldLabel(e: Entity, name: string): string {
  if (name === "created_at") return "создания записи";
  return `«${e.fields.find((f) => f.name === name)?.label ?? name}»`;
}

function retentionLine(spec: AppSpec, e: Entity): string {
  const r = e.retention;
  if (!r) {
    const waiver = spec.compliance?.retentionWaiver?.reason;
    return `${e.label}: срок не задан${waiver ? ` (основание владельца: ${waiver})` : ""}`;
  }
  const action = (r.mode ?? "delete") === "anonymize" ? "обезличивание" : "удаление";
  return `${e.label}: ${r.deleteAfterDays} дн. от ${fieldLabel(e, r.anchorField ?? "created_at")}, затем ${action}`;
}

export interface PolicyFacts {
  appName: string;
  operatorName: string;
  operator: string;
  purposes: string;
  dataCategories: string;
  actions: string;
  retention: string;
  processors: string;
  withdrawal: string;
  dataSummary: string;
  processorsSummary: string;
  retentionSummary: string;
  withdrawalSummary: string;
}

export function policyFacts(spec: AppSpec): PolicyFacts {
  const c = spec.compliance ?? {};
  const piiEntities = spec.entities.filter((e) => piiFieldsOf(e).length > 0);
  const login = loginData(spec);
  const page = effectivePolicyPage(spec);
  const operator = [
    `Наименование: ${c.operatorName ?? NOT_SET}`,
    `Адрес: ${c.operatorAddress ?? NOT_SET}`,
    ...(c.operatorInn ? [`ИНН: ${c.operatorInn}`] : []),
    `Контакт для обращений: ${c.operatorContact ?? NOT_SET}`,
  ];
  const purposes = [
    `${spec.app.name}${spec.app.description ? `: ${spec.app.description}` : ""}`,
    ...(piiEntities.length ? [`Ведение записей: ${piiEntities.map((e) => e.label).join(", ")}`] : []),
    ...(login.length ? ["Вход пользователей в систему"] : []),
  ];
  const categories = [
    ...piiEntities.map(
      (e) =>
        `${e.label}: ${piiFieldsOf(e)
          .map((f) => f.label)
          .join(", ")}`,
    ),
    ...(login.length ? [`Данные входа: ${login.join(", ")}`] : []),
  ];
  const actions = piiEntities.map((e) => {
    const byOp = new Map<string, string[]>();
    for (const p of spec.permissions.filter((x) => x.entity === e.name))
      for (const op of p.ops) byOp.set(op, [...(byOp.get(op) ?? []), roleLabel(spec, p.role)]);
    const parts = ["create", "read", "update", "delete"]
      .filter((op) => byOp.has(op))
      .map((op) => `${OP_LABELS[op]} (${(byOp.get(op) as string[]).join(", ")})`);
    if (e.retention)
      parts.push(e.retention.mode === "anonymize" ? "обезличивание по сроку" : "удаление по сроку");
    return `${e.label}: ${parts.length ? parts.join("; ") : "хранение"}`;
  });
  if (login.length) actions.push("Данные входа: запись при первом входе, хранение, обезличивание по сроку");
  const retention = [
    ...piiEntities.map((e) => retentionLine(spec, e)),
    ...(login.length ? ["Данные входа: 3 года с последнего входа, затем обезличивание"] : []),
    "Журнал согласий: срок хранения записей плюс 3 года",
  ];
  const processors = systemProcessors(spec);
  const withdrawal = [
    `Отозвать согласие: страница «Мои данные» (${PRIVACY_PAGE}) после входа; вход закрывается, данные обезличиваются не позднее 30 дней`,
    `Запросы о своих данных (выгрузка, удаление): ${c.operatorContact ?? NOT_SET}; ответ — не позднее 10 рабочих дней`,
  ];
  const labels = new Set<string>();
  for (const e of piiEntities) for (const f of piiFieldsOf(e)) labels.add(f.label.toLowerCase());
  for (const l of login) labels.add(l);
  return {
    appName: oneLine(spec.app.name),
    operatorName: oneLine(c.operatorName ?? NOT_SET),
    operator: list(operator, NOT_SET),
    purposes: list(purposes, spec.app.name),
    dataCategories: list(categories, "не собираются"),
    actions: list(actions, "не выполняются"),
    retention: list(retention, "не задано"),
    processors: list(
      processors.map((p) => `${p.name} — ${p.purpose}`),
      "нет",
    ),
    withdrawal: list(withdrawal, ""),
    dataSummary: [...labels].join(", ") || "контактные данные",
    processorsSummary: processors.map((p) => p.name).join(", "),
    retentionSummary: page ? `по срокам из политики (${page})` : "по срокам из политики оператора",
    withdrawalSummary: `на странице «Мои данные» (${PRIVACY_PAGE}) или по адресу ${oneLine(c.operatorContact ?? NOT_SET)}`,
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface RenderedPolicy {
  /** Markdown with {{version}} and {{date}} filled. */
  markdown: string;
  /** policyVersion: sha256 of the text without version and date (hex, 16). */
  version: string;
  templateVersion: string;
  draft: boolean;
}

/** null when the registry has no policy template. */
export function renderPolicy(spec: AppSpec, templates: LegalTemplates, date?: string): RenderedPolicy | null {
  const t = templates.get("policy", "privacy");
  if (!t) return null;
  const facts = policyFacts(spec);
  const body = fillTemplate(t.body, { ...facts });
  const version = sha256(body).slice(0, 16);
  return {
    markdown: fillTemplate(body, { version, date: date ?? "—" }),
    version,
    templateVersion: t.version,
    draft: t.status === "draft",
  };
}

/** Consent text from compliance.consentTemplateId (unknown or missing → default); null without a template. */
export function renderConsentText(spec: AppSpec, templates: LegalTemplates): string | null {
  const id = spec.compliance?.consentTemplateId ?? "default";
  const t = templates.get("consent", id) ?? templates.get("consent", "default");
  if (!t) return null;
  return oneLine(fillTemplate(t.body, { ...policyFacts(spec) }));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Markdown subset of the templates: #/##/### headings, `- ` lists and paragraphs; everything is escaped. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let items: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (items.length) out.push(`<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`);
    if (para.length) out.push(`<p>${escapeHtml(para.join(" "))}</p>`);
    items = [];
    para = [];
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      const level = Math.min(3, (h[1] as string).length + 1);
      out.push(`<h${level}>${escapeHtml(h[2] as string)}</h${level}>`);
    } else if (line.startsWith("- ")) {
      if (para.length) flush();
      items.push(line.slice(2));
    } else {
      if (items.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join("");
}
