// Columns of an import as S-import sees them (api.yaml#getImport, #ImportColumnMapping): one key per column — the raw
// header (sheet-prefixed for several sheets), never a cell value. The LLM side uses the payload names (after scrub).
import { type AppSpec, type FieldType, isReservedName } from "@wizard/appspec";
import type { ImportColumnMapping as LlmMapping } from "@wizard/llm";
import type { InferredType, SheetProfile, SyntheticPayload } from "@wizard/pii/import";
import { IMPORTABLE } from "./load.js";

/** Stored profile item (platform.imports.profile); the API returns the documented fields + sheet. */
export interface ProfileItem {
  column: string;
  sheet: string;
  typeGuess: InferredType;
  piiKindGuess: string | null;
  nullShare: number;
  distinct: number;
  /** Position in the table; payload names the mapper used. */
  sheetIndex: number;
  index: number;
  payloadSheet: string;
  payloadColumn: string;
}

/** api.yaml#/components/schemas/ImportColumnMapping */
export interface ApiMapping {
  column: string;
  action: "map" | "skip" | "new_field";
  entity?: string;
  field?: string;
  pii?: "none" | "basic";
}

export const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Profile items in table order; keys are unique across the table. */
export function profileItems(profile: readonly SheetProfile[], payload: SyntheticPayload): ProfileItem[] {
  const multi = profile.length > 1;
  const seen = new Map<string, number>();
  const out: ProfileItem[] = [];
  profile.forEach((sheet, si) => {
    const sheetName = sheet.name.trim() || `Лист ${si + 1}`;
    for (const c of sheet.columns) {
      const header = c.header.trim() || `Колонка ${c.index + 1}`;
      const base = multi ? `${sheetName} / ${header}` : header;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const ps = payload.sheets[si];
      out.push({
        column: n === 1 ? base : `${base} (${n})`,
        sheet: sheetName,
        typeGuess: c.inferredType,
        piiKindGuess: c.piiKindGuess,
        nullShare: c.nullShare,
        distinct: c.distinct,
        sheetIndex: si,
        index: c.index,
        payloadSheet: ps?.name ?? "",
        payloadColumn: ps?.columns[c.index]?.header ?? "",
      });
    }
  });
  return out;
}

export const apiProfile = (items: readonly ProfileItem[]) =>
  items.map((p) => ({
    column: p.column,
    sheet: p.sheet,
    typeGuess: p.typeGuess,
    piiKindGuess: p.piiKindGuess,
    nullShare: p.nullShare,
    distinct: p.distinct,
  }));

const clean = (m: ApiMapping): ApiMapping => ({
  column: m.column,
  action: m.action,
  ...(m.action !== "skip" && m.entity ? { entity: m.entity } : {}),
  ...(m.action !== "skip" && m.field ? { field: m.field } : {}),
  pii: m.pii ?? "none",
});

/** The mapper's proposal (one item per payload column, payload order) → API mapping by column key. */
export function fromLlm(items: readonly ProfileItem[], mapping: readonly LlmMapping[]): ApiMapping[] {
  return items.map((p) => {
    const m = mapping.find((x) => x.sheet === p.payloadSheet && x.column === p.payloadColumn);
    const pii = p.piiKindGuess !== null || m?.pii === "basic" ? "basic" : "none";
    if (!m) return { column: p.column, action: "skip", pii };
    return clean({ ...m, column: p.column, pii });
  });
}

/** API mapping → loadRows mapping (payload names); new_field items must be resolved to fields beforehand. */
export function toLoad(items: readonly ProfileItem[], mapping: readonly ApiMapping[]): LlmMapping[] {
  const out: LlmMapping[] = [];
  for (const m of mapping) {
    const p = items.find((x) => x.column === m.column);
    if (!p || m.action !== "map" || !m.entity || !m.field) continue;
    out.push({
      sheet: p.payloadSheet,
      column: p.payloadColumn,
      action: "map",
      entity: m.entity,
      field: m.field,
    });
  }
  return out;
}

/** Field type of a new field for a column (builder hint). */
export function fieldTypeFor(t: InferredType): FieldType {
  const map: Partial<Record<InferredType, FieldType>> = {
    integer: "int",
    number: "decimal",
    boolean: "bool",
    date: "date",
    datetime: "datetime",
    email: "email",
    phone: "phone",
    url: "url",
    free_text: "text",
  };
  return map[t] ?? "string";
}

/** Field name of a new_field item without one: latin payload header or col_<n>. */
export function newFieldName(p: ProfileItem): string {
  const slug = p.payloadColumn
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return IDENT_RE.test(slug) && !isReservedName(slug) ? slug : `col_${p.index + 1}`;
}

export interface MappingProblem {
  column: string;
  message_ru: string;
}

/**
 * PUT mapping (api.yaml#updateImportMapping): the full mapping in profile order; columns not mentioned are skipped.
 * Returns problems for unknown columns/targets (→ 422).
 */
export function normalizeMapping(
  items: readonly ProfileItem[],
  spec: AppSpec,
  input: readonly ApiMapping[],
): { mapping: ApiMapping[]; problems: MappingProblem[] } {
  const problems: MappingProblem[] = [];
  const byColumn = new Map<string, ApiMapping>();
  for (const m of input) {
    if (!items.some((p) => p.column === m.column))
      problems.push({ column: m.column, message_ru: "Такой колонки нет в таблице" });
    else if (byColumn.has(m.column))
      problems.push({ column: m.column, message_ru: "Колонка указана дважды" });
    else byColumn.set(m.column, m);
  }
  const targets = new Set<string>();
  const mapping = items.map((p): ApiMapping => {
    const given = byColumn.get(p.column);
    const pii = given?.pii ?? (p.piiKindGuess !== null ? "basic" : "none");
    if (!given) return { column: p.column, action: "skip", pii };
    const m: ApiMapping = { ...given, pii };
    const bad = (message_ru: string) => problems.push({ column: p.column, message_ru });
    if (m.action === "skip") return clean(m);
    const entity = spec.entities.find((e) => e.name === m.entity);
    if (m.action === "map") {
      const field = entity?.fields.find((f) => f.name === m.field);
      if (!entity || !field) bad("Поле не найдено в системе");
      else if (!IMPORTABLE.has(field.type)) bad("В поле такого типа значения из таблицы не загружаются");
    } else {
      const name = m.field ?? newFieldName(p);
      if (!m.entity || !IDENT_RE.test(m.entity)) bad("Укажите сущность для нового поля");
      else if (!IDENT_RE.test(name) || isReservedName(name))
        bad("Имя нового поля — латиница, цифры и «_», с буквы");
      else if (entity?.fields.some((f) => f.name === name))
        bad("Такое поле уже есть — выберите его вместо нового");
      m.field = name;
    }
    const key = `${m.entity}.${m.field}`;
    if (targets.has(key)) bad("В это поле уже загружается другая колонка");
    targets.add(key);
    return clean(m);
  });
  return { mapping, problems };
}
