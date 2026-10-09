// Field mapping of a contract (V3-20): which data fields of the brief (or entities of the spec) go into which request
// fields of the API and which answer fields come back — by code, through name normalisation and groups of synonyms
// (Russian and English). The model maps only what code cannot: prose documentation (prose.ts).
import type { ContractMapping, IntegrationContract } from "./contract.js";
import type { ApiSchema } from "./schema.js";

/** A data source of the system: brief data (Russian names) or spec entities (identifiers and labels). */
export interface MappingEntity {
  entity: string;
  fields: { name: string; label?: string }[];
}

/** Groups of names that mean the same field. */
const GROUPS: readonly (readonly string[])[] = [
  ["name", "fullname", "fio", "имя", "фио", "clientname", "customername", "contactname", "firstname"],
  ["phone", "phonenumber", "tel", "telephone", "mobile", "телефон", "номертелефона"],
  ["email", "mail", "почта", "электроннаяпочта", "emailaddress"],
  ["comment", "comments", "note", "notes", "message", "комментарий", "сообщение", "примечание"],
  ["price", "amount", "sum", "total", "cost", "цена", "сумма", "стоимость"],
  ["address", "адрес", "addr", "deliveryaddress"],
  ["date", "дата", "datetime", "startsat", "start", "времязаписи"],
  ["title", "name", "название", "наименование", "subject", "тема"],
  ["status", "статус", "state"],
  ["quantity", "qty", "count", "количество", "кол"],
  ["company", "companyname", "organization", "компания", "организация"],
  ["city", "город"],
  ["source", "источник", "utmsource"],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/ё/g, "е");

function groupsOf(name: string): Set<number> {
  const n = norm(name);
  const out = new Set<number>();
  GROUPS.forEach((g, i) => {
    if (g.includes(n)) out.add(i);
  });
  return out;
}

function same(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na && na === nb) return true;
  const ga = groupsOf(a);
  for (const g of groupsOf(b)) if (ga.has(g)) return true;
  return false;
}

/** Top-level properties of an object schema (or of the items of an array answer). */
function topProps(s: ApiSchema): string[] {
  if (s.type === "array" && s.items) return topProps(s.items);
  return Object.keys(s.properties ?? {});
}

/**
 * Deterministic mapping: every data field to the request properties of writing operations (to_api) and to the
 * answer properties of every operation (from_api) whose names match. Stable order, capped by the contract limit.
 */
export function mapFields(
  contract: IntegrationContract,
  data: readonly MappingEntity[],
  cap = 100,
): ContractMapping[] {
  const out: ContractMapping[] = [];
  const seen = new Set<string>();
  const push = (m: ContractMapping) => {
    const k = `${m.entity}|${m.field}|${m.operation}|${m.pointer}`;
    if (seen.has(k) || out.length >= cap) return;
    seen.add(k);
    out.push(m);
  };
  for (const e of data)
    for (const f of e.fields) {
      const names = [f.name, ...(f.label ? [f.label] : [])];
      for (const op of contract.operations) {
        const writes = op.method !== "GET" && op.method !== "DELETE";
        if (writes && op.body)
          for (const p of topProps(op.body.schema))
            if (names.some((n) => same(n, p)))
              push({
                entity: e.entity,
                field: f.name,
                operation: op.id,
                pointer: `/body/${p}`,
                direction: "to_api",
                by: "name",
              });
        if (writes)
          for (const p of op.params)
            if (p.in === "query" && names.some((n) => same(n, p.name)))
              push({
                entity: e.entity,
                field: f.name,
                operation: op.id,
                pointer: `/query/${p.name}`,
                direction: "to_api",
                by: "name",
              });
        for (const p of topProps(op.response.schema))
          if (names.some((n) => same(n, p)))
            push({
              entity: e.entity,
              field: f.name,
              operation: op.id,
              pointer: `/response/${p}`,
              direction: "from_api",
              by: "name",
            });
      }
    }
  return out;
}
