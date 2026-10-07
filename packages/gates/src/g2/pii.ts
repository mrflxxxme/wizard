// G2-PII-01…06 (specs/quality/gates.yaml#G2, security/compliance.yaml#system_package, abuse.yaml#subject_entities).
import { type AppSpec, type Entity, fieldPiiCategory, isPiiSubject, piiNameReason } from "@wizard/appspec";
import ts from "typescript";
import { importGraph, reachable } from "../g0/imports.js";
import type { SourceInfo } from "../g0/source.js";
import type { Finding } from "../report.js";
import { ABUSE, firstMatch, normalize, rx, splitIdent } from "./patterns.js";

const RE = {
  special: rx(ABUSE.special.names, "giu"),
};

const hasPii = (e: Entity) => e.fields.some((f) => fieldPiiCategory(f) !== "none");

/** abuse.yaml#subject_entities: pii≠none field, ref to users, or a strong ПДн field name (@wizard/appspec, B2-46). */
export const isSubject: (e: Entity) => boolean = isPiiSubject;

/** Package 152-ФЗ applies (compliance.yaml#system_package.applies_when). */
export function packageApplies(spec: AppSpec): boolean {
  return spec.entities.some(hasPii) || spec.roles.some((r) => r.access === "login");
}

/** G2-PII-01: no special/biometric categories. */
export function forbiddenCategories(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  for (const [i, e] of spec.entities.entries())
    for (const [j, f] of e.fields.entries())
      if (f.pii === "special" || f.pii === "biometric")
        out.push({
          message_ru: `Поле «${f.label}» (${e.label}) относится к особой категории ПДн — такие данные собирать нельзя`,
          path: `/entities/${i}/fields/${j}/pii`,
          evidence: `PII_CATEGORY_FORBIDDEN: pii=${f.pii}`,
          fixHint: "Уберите поле или замените его неличными сведениями",
        });
  return out;
}

/** G2-PII-02: e-mail/phone types and ПДн-like names are marked pii≠none. */
export function markup(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  for (const [i, e] of spec.entities.entries()) {
    const subject = isSubject(e);
    for (const [j, f] of e.fields.entries()) {
      if (fieldPiiCategory(f) !== "none") continue;
      // The same criterion marks module extra fields at compile time (@wizard/appspec piiNameReason, B2-46).
      const why = piiNameReason(f, subject)?.why;
      if (why)
        out.push({
          message_ru: `Поле «${f.label}» (${e.label}) похоже на персональные данные, но не размечено как ПДн`,
          path: `/entities/${i}/fields/${j}`,
          evidence: `${why}; pii=none`,
          fixHint: `Укажите pii: "basic" (и piiKind) у поля ${e.name}.${f.name}`,
        });
    }
  }
  return out;
}

/** G2-PII-03: special-category hints in subject entities (names, labels, enum labels). */
export function specialHints(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  for (const [i, e] of spec.entities.entries()) {
    if (!isSubject(e)) continue;
    const texts: [string, string][] = [
      [`/entities/${i}`, e.label],
      [`/entities/${i}`, splitIdent(e.name)],
    ];
    for (const [j, f] of e.fields.entries()) {
      const p = `/entities/${i}/fields/${j}`;
      texts.push([p, f.label], [p, splitIdent(f.name)]);
      for (const [k, o] of (f.enum ?? []).entries()) texts.push([`${p}/enum/${k}`, o.label]);
    }
    const seen = new Set<string>();
    for (const [path, t] of texts) {
      const m = firstMatch(RE.special, normalize(t));
      if (!m || seen.has(path)) continue;
      seen.add(path);
      out.push({
        message_ru: `«${t}» (${e.label}) похоже на сведения особой категории (здоровье, религия, судимость…) — их собирать нельзя`,
        path,
        evidence: `special_categories: «${m.text}»`,
        fixHint: "Переформулируйте без медицинских и иных особых сведений (например, «пожелания по питанию»)",
      });
    }
  }
  return out;
}

const CONSENT_TAGS = new Set(["ConsentCheckbox", "RecordForm"]);

/** G2-PII-04: pages that write ПДн for a non-admin role contain the consent checkbox; consent text and policy. */
export function consentForms(
  spec: AppSpec,
  sources: SourceInfo[],
  files: ReadonlyMap<string, string>,
): Finding[] {
  const out: Finding[] = [];
  const ui = sources.filter((s) => s.area === "ui");
  const byPath = new Map(ui.map((s) => [s.path, s]));
  const graph = importGraph(ui, files);
  const roles = new Map(spec.roles.map((r) => [r.name, r]));
  const entities = new Map(spec.entities.map((e) => [e.name, e]));
  const writesPii = (role: string, entity: string): boolean => {
    const e = entities.get(entity);
    const p = spec.permissions.find((x) => x.role === role && x.entity === entity);
    if (!e || !p || !hasPii(e)) return false;
    if (p.ops.includes("create")) return true;
    if (!p.ops.includes("update")) return false;
    const closed = new Set([...(p.readonlyFields ?? []), ...(p.hiddenFields ?? [])]);
    return e.fields.some((f) => fieldPiiCategory(f) !== "none" && !closed.has(f.name));
  };
  for (const [i, page] of (spec.pages ?? []).entries()) {
    const nonAdmin = page.roles.filter((r) => roles.get(r)?.isAdmin !== true);
    if (nonAdmin.length === 0) continue;
    let consent = false;
    const needs: string[] = [];
    for (const path of reachable([page.file], graph)) {
      const src = byPath.get(path);
      if (!src) continue;
      const visit = (n: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
          CONSENT_TAGS.has(n.tagName.getText())
        )
          consent = true;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const hook = src.sdkImports.get(n.expression.text) ?? n.expression.text;
          const a = n.arguments[0];
          const name = a && ts.isStringLiteralLike(a) ? a.text : null;
          if (name && hook === "useEntityMutation" && nonAdmin.some((r) => writesPii(r, name)))
            needs.push(`запись «${entities.get(name)?.label ?? name}»`);
          if (name && hook === "useMutation") {
            const fn = (spec.functions ?? []).find((f) => f.name === name);
            if (fn?.collectsPii && (fn.roles ?? []).some((r) => nonAdmin.includes(r)))
              needs.push(`функция ${name} (collectsPii)`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(src.sf);
    }
    if (needs.length && !consent)
      out.push({
        message_ru: `Страница «${page.title}» собирает персональные данные без отметки согласия на их обработку`,
        file: page.file,
        path: `/pages/${i}`,
        evidence: `нет ConsentCheckbox/RecordForm; ${[...new Set(needs)].join(", ")}`,
        fixHint: "Добавьте ConsentCheckbox из @wizard/ui-kit в форму и передавайте { consent: true }",
      });
  }
  if (packageApplies(spec)) {
    const c = spec.compliance ?? {};
    if (c.consentText !== undefined && c.consentText.trim() === "")
      out.push({
        message_ru: "Текст согласия на обработку ПДн пустой",
        path: "/compliance/consentText",
        fixHint: "Уберите consentText (будет шаблон) или задайте текст",
      });
    const policy = c.policyPage ?? "/privacy";
    if (!policy.startsWith("/") || (spec.pages ?? []).some((p) => p.route === policy))
      out.push({
        message_ru:
          "Страница политики обработки ПДн недоступна: адрес занят страницей системы или задан неверно",
        path: "/compliance/policyPage",
        evidence: `policyPage=${policy}`,
      });
  }
  return out;
}

/** G2-PII-05: every entity with pii=basic has retention (or compliance.retentionWaiver). */
export function retention(spec: AppSpec): Finding[] {
  if (spec.compliance?.retentionWaiver) return [];
  const out: Finding[] = [];
  for (const [i, e] of spec.entities.entries()) {
    if (e.retention || !e.fields.some((f) => fieldPiiCategory(f) === "basic")) continue;
    out.push({
      message_ru: `Для «${e.label}» не задан срок хранения персональных данных`,
      path: `/entities/${i}/retention`,
      fixHint:
        "Добавьте retention.deleteAfterDays (событие — 30 дней после даты, заказ — 3 года, заявка — 1 год)",
    });
  }
  return out;
}

/** ИНН-10/12 checksum (ФНС). */
export function innValid(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = [...inn].map(Number);
  const sum = (w: number[]) => (w.reduce((s, x, k) => s + x * (d[k] as number), 0) % 11) % 10;
  if (d.length === 10) return sum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** G2-PII-06: operator data (name, contact; address from M2) and the ИНН checksum. */
export function operator(spec: AppSpec, afterM2: boolean): Finding[] {
  const c = spec.compliance ?? {};
  const out: Finding[] = [];
  const blank = (v: string | undefined) => v === undefined || v.trim() === "";
  if (packageApplies(spec)) {
    const need: [string, string | undefined, string, string][] = [
      [
        "operatorName",
        c.operatorName,
        "OPERATOR_NAME_REQUIRED",
        "название оператора ПДн (юрлицо, ИП или ФИО)",
      ],
      ["operatorContact", c.operatorContact, "OPERATOR_CONTACT_REQUIRED", "контакт оператора для обращений"],
    ];
    if (afterM2)
      need.push(["operatorAddress", c.operatorAddress, "OPERATOR_ADDRESS_REQUIRED", "адрес оператора ПДн"]);
    for (const [key, v, code, what] of need)
      if (blank(v))
        out.push({
          message_ru: `Не указано: ${what}. Без этого систему с персональными данными нельзя опубликовать`,
          path: `/compliance/${key}`,
          evidence: code,
          fixHint: "Заполняет владелец в настройках системы (данные оператора)",
        });
  }
  if (c.operatorInn !== undefined && !innValid(c.operatorInn))
    out.push({
      message_ru: "ИНН оператора указан с ошибкой",
      path: "/compliance/operatorInn",
      evidence: "INN_INVALID",
      fixHint: "Проверьте ИНН (10 цифр для организации, 12 — для ИП и физлица)",
    });
  return out;
}
