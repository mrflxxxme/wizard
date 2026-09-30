// Spec-to-spec human diff (api.yaml getRevisionDiff; workflows.yaml#workflows.publish confirmDiff): deterministic
// Russian lines describing what changes between two revisions, independent of the ops that produced them.
import type { AppSpec, Entity, Field, Permission } from "./schema.js";

export type SpecChangeKind =
  | "entity"
  | "field"
  | "role"
  | "permission"
  | "page"
  | "workflow"
  | "integration"
  | "function"
  | "theme"
  | "compliance"
  | "file";

export interface SpecChange {
  kind: SpecChangeKind;
  text_ru: string;
  /** Data can be lost or rejected (removal, type change, new NOT NULL): prod refuses it (ops.yaml#migrations). */
  destructive?: boolean;
}

const OPS_RU: Record<string, string> = {
  read: "смотреть",
  create: "создавать",
  update: "изменять",
  delete: "удалять",
};
const CONNECTOR_RU: Record<string, string> = {
  yookassa: "оплата ЮKassa",
  telegram: "Telegram",
  email: "почта",
  qr: "QR-коды",
};
const FIELD_KEYS_RU: [keyof Field, string][] = [
  ["label", "название"],
  ["required", "обязательность"],
  ["unique", "уникальность"],
  ["default", "значение по умолчанию"],
  ["enum", "варианты"],
  ["ref", "связь"],
  ["pii", "категория ПДн"],
  ["min", "минимум"],
  ["max", "максимум"],
  ["maxLength", "длина"],
];
const TYPE_RU: Record<string, string> = {
  string: "строка",
  text: "текст",
  int: "целое число",
  decimal: "число",
  money: "сумма",
  bool: "да/нет",
  date: "дата",
  datetime: "дата и время",
  enum: "список",
  ref: "ссылка",
  file: "файл",
  json: "данные JSON",
  email: "e-mail",
  phone: "телефон",
  url: "ссылка на сайт",
  qr_token: "QR-код",
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function byKey<T>(list: readonly T[] | undefined, key: (x: T) => string): Map<string, T> {
  return new Map((list ?? []).map((x) => [key(x), x]));
}

/** Added / removed / changed items of two keyed lists, in `next` order (removed ones in `prev` order, first). */
function pairs<T>(prev: readonly T[] | undefined, next: readonly T[] | undefined, key: (x: T) => string) {
  const a = byKey(prev, key);
  const b = byKey(next, key);
  const removed = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
  const added: T[] = [];
  const changed: [T, T][] = [];
  for (const [k, v] of b) {
    const old = a.get(k);
    if (old === undefined) added.push(v);
    else if (!same(old, v)) changed.push([old, v]);
  }
  return { removed, added, changed };
}

function opsRu(p: Permission): string {
  const own = p.rowFilter && Object.keys(p.rowFilter).length > 0 ? ", только свои" : "";
  return `${p.ops.map((o) => OPS_RU[o] ?? o).join(", ")}${own}`;
}

function fieldChange(e: Entity, a: Field, b: Field): SpecChange {
  if (a.type !== b.type)
    return {
      kind: "field",
      text_ru: `В «${e.label}» у поля «${b.label}» сменился тип: ${TYPE_RU[a.type] ?? a.type} → ${TYPE_RU[b.type] ?? b.type} (значения будут потеряны)`,
      destructive: true,
    };
  const what = FIELD_KEYS_RU.filter(([k]) => !same(a[k], b[k])).map(([, ru]) => ru);
  if (a.piiKind !== b.piiKind && !what.includes("категория ПДн")) what.push("категория ПДн");
  const madeRequired = !a.required && b.required === true;
  const label = a.label !== b.label ? `«${a.label}» → «${b.label}»` : `«${b.label}»`;
  return {
    kind: "field",
    text_ru: `В «${e.label}» изменено поле ${label}: ${what.join(", ") || "настройки"}`,
    ...(madeRequired ? { destructive: true } : {}),
  };
}

function entityChanges(prev: AppSpec, next: AppSpec): SpecChange[] {
  const out: SpecChange[] = [];
  const { removed, added, changed } = pairs(prev.entities, next.entities, (e) => e.name);
  for (const e of removed)
    out.push({ kind: "entity", text_ru: `Удалены данные «${e.label}» вместе с записями`, destructive: true });
  for (const e of added)
    out.push({ kind: "entity", text_ru: `Добавлены данные «${e.label}» (${e.fields.length} полей)` });
  for (const [a, b] of changed) {
    if (a.label !== b.label)
      out.push({ kind: "entity", text_ru: `Данные «${a.label}» переименованы в «${b.label}»` });
    const settings = (["indexes", "ownerField", "retention"] as const).filter((k) => !same(a[k], b[k]));
    if (settings.length > 0) {
      const ru = settings.map((k) =>
        k === "indexes" ? "поиск и уникальность" : k === "ownerField" ? "владелец записи" : "срок хранения",
      );
      out.push({ kind: "entity", text_ru: `Изменены настройки данных «${b.label}»: ${ru.join(", ")}` });
    }
    const f = pairs(a.fields, b.fields, (x) => x.name);
    for (const x of f.removed)
      out.push({
        kind: "field",
        text_ru: `Из «${b.label}» удалено поле «${x.label}» вместе со значениями`,
        destructive: true,
      });
    for (const x of f.added)
      out.push({
        kind: "field",
        text_ru: `В «${b.label}» добавлено поле «${x.label}» (${TYPE_RU[x.type] ?? x.type}${x.required ? ", обязательное" : ""})`,
      });
    for (const [x, y] of f.changed) out.push(fieldChange(b, x, y));
  }
  return out;
}

/**
 * Human-readable changes from `prev` to `next` (null = empty system). Labels of removed items come from `prev`.
 * Files are not part of the spec: the caller adds kind=file lines from the revision manifests.
 */
export function diffSpecs(prev: AppSpec | null, next: AppSpec): SpecChange[] {
  const p: AppSpec = prev ?? { ...next, entities: [], roles: [], permissions: [] };
  const base = prev ?? ({} as Partial<AppSpec>);
  const out: SpecChange[] = [];

  if (prev && !same(prev.app, next.app))
    out.push({ kind: "theme", text_ru: "Изменены название или описание системы" });
  if (!same(base.theme, next.theme)) out.push({ kind: "theme", text_ru: "Изменён стиль" });

  out.push(...entityChanges(p, next));

  const entityLabel = (name: string) =>
    (next.entities.find((e) => e.name === name) ?? p.entities.find((e) => e.name === name))?.label ?? name;
  const roleLabel = (name: string) =>
    (next.roles.find((r) => r.name === name) ?? p.roles.find((r) => r.name === name))?.label ?? name;

  const roles = pairs(p.roles, next.roles, (r) => r.name);
  for (const r of roles.removed)
    out.push({ kind: "role", text_ru: `Удалена роль «${r.label}»`, destructive: true });
  for (const r of roles.added) out.push({ kind: "role", text_ru: `Добавлена роль «${r.label}»` });
  for (const [a, b] of roles.changed)
    out.push({
      kind: "role",
      text_ru:
        a.label !== b.label ? `Роль «${a.label}» переименована в «${b.label}»` : `Изменена роль «${b.label}»`,
    });

  const perms = pairs(p.permissions, next.permissions, (x) => `${x.role}\u0000${x.entity}`);
  for (const x of perms.removed)
    out.push({
      kind: "permission",
      text_ru: `«${roleLabel(x.role)}» больше не имеет доступа к «${entityLabel(x.entity)}»`,
    });
  for (const x of perms.added)
    out.push({
      kind: "permission",
      text_ru: `«${roleLabel(x.role)}» теперь может: ${opsRu(x)} — «${entityLabel(x.entity)}»`,
    });
  for (const [, x] of perms.changed)
    out.push({
      kind: "permission",
      text_ru: `Изменены права «${roleLabel(x.role)}» на «${entityLabel(x.entity)}»: ${opsRu(x)}`,
    });

  const pages = pairs(base.pages, next.pages, (x) => x.route);
  for (const x of pages.removed) out.push({ kind: "page", text_ru: `Удалён экран «${x.title}»` });
  for (const x of pages.added) out.push({ kind: "page", text_ru: `Новый экран «${x.title}»` });
  for (const [, x] of pages.changed) out.push({ kind: "page", text_ru: `Изменён экран «${x.title}»` });

  const wf = pairs(base.workflows, next.workflows, (x) => x.name);
  for (const x of wf.removed)
    out.push({ kind: "workflow", text_ru: `Удалена автоматизация: ${x.label ?? x.name}` });
  for (const x of wf.added)
    out.push({ kind: "workflow", text_ru: `Новая автоматизация: ${x.label ?? x.name}` });
  for (const [, x] of wf.changed)
    out.push({ kind: "workflow", text_ru: `Изменена автоматизация: ${x.label ?? x.name}` });

  const conn = (c: string) => CONNECTOR_RU[c] ?? c;
  const ints = pairs(base.integrations, next.integrations, (x) => x.name);
  for (const x of ints.removed) out.push({ kind: "integration", text_ru: `Отключено: ${conn(x.connector)}` });
  for (const x of ints.added) out.push({ kind: "integration", text_ru: `Подключено: ${conn(x.connector)}` });
  for (const [, x] of ints.changed)
    out.push({ kind: "integration", text_ru: `Изменены настройки подключения: ${conn(x.connector)}` });

  const fns = pairs(base.functions, next.functions, (x) => x.name);
  const ai = pairs(base.aiActions, next.aiActions, (x) => x.name);
  const fnLines: [number, string][] = [
    [fns.added.length, "Добавлена серверная логика"],
    [fns.removed.length, "Удалена серверная логика"],
    [fns.changed.length, "Изменена серверная логика"],
    [ai.added.length, "Новое ИИ-действие"],
    [ai.removed.length, "Удалено ИИ-действие"],
    [ai.changed.length, "Изменено ИИ-действие"],
  ];
  for (const [n, text] of fnLines)
    if (n > 0) out.push({ kind: "function", text_ru: n > 1 ? `${text} (×${n})` : text });

  if (!same(base.compliance, next.compliance)) {
    const a = base.compliance ?? {};
    const b = next.compliance ?? {};
    const operator = (["operatorName", "operatorContact", "operatorAddress", "operatorInn"] as const).some(
      (k) => !same(a[k], b[k]),
    );
    out.push({
      kind: "compliance",
      text_ru: operator ? "Обновлены сведения об операторе ПДн" : "Обновлены настройки персональных данных",
    });
  }
  return out;
}
