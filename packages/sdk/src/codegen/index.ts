// @wizard/sdk/codegen — generateTypes(spec) → `_generated/wizard.d.ts` (sdk.md §4): module augmentation
// of the Entities, Roles, Functions, Connectors and Payments registries of "@wizard/sdk".
import type { AppSpec, Entity, Field } from "@wizard/appspec";
import { entityIndexes, uniqueFields } from "../host/indexes.js";

export interface GenerateTypesOptions {
  /** Path from `_generated/` to the system root used in `typeof import(...)` (default "../"). */
  importBase?: string;
}

const CONNECTOR_TYPES: Record<string, string> = {
  yookassa: "YookassaConnector",
  telegram: "TelegramConnector",
  email: "EmailConnector",
  qr: "QrConnector",
};

const SYSTEM_TYPES: Record<string, (entity: string) => string> = {
  id: (e) => `Id<${JSON.stringify(e)}>`,
  created_at: () => "string",
  updated_at: () => "string | null",
  created_by: () => 'Id<"users"> | null',
};

/** Field types where `where` may use a range on the last index key. */
const RANGE_TYPES = new Set([
  "string",
  "text",
  "email",
  "phone",
  "url",
  "int",
  "decimal",
  "money",
  "date",
  "datetime",
]);

function baseType(f: Field): string {
  switch (f.type) {
    case "int":
    case "decimal":
    case "money":
      return "number";
    case "bool":
      return "boolean";
    case "enum":
      return (f.enum ?? []).map((o) => JSON.stringify(o.value)).join(" | ") || "never";
    case "ref":
      return `Id<${JSON.stringify(f.ref?.entity ?? "users")}>`;
    case "json":
      return "Json";
    default:
      return "string";
  }
}

function valueType(f: Field): string {
  return f.required ? baseType(f) : `${baseType(f)} | null`;
}

function comment(text: string): string {
  return `/** ${text.replace(/\*\//g, "*\\/").replace(/\s+/g, " ")} */`;
}

function obj(members: string[], indent: string): string {
  if (members.length === 0) return "{}";
  return `{\n${members.map((m) => `${indent}  ${m}`).join("\n")}\n${indent}}`;
}

/** Hidden for at least one role → optional in ClientDoc (sdk.md §4). */
function hiddenSomewhere(spec: AppSpec, entity: string): Set<string> {
  const out = new Set<string>();
  for (const p of spec.permissions) if (p.entity === entity) for (const h of p.hiddenFields ?? []) out.add(h);
  return out;
}

function whereKeyType(entity: Entity, key: string, last: boolean): string {
  const sys = SYSTEM_TYPES[key];
  if (sys) {
    const t = sys(entity.name);
    return last && key === "created_at" ? `${t} | Range<${t}>` : t;
  }
  const f = entity.fields.find((x) => x.name === key);
  if (!f) return "never";
  const t = valueType(f);
  return last && RANGE_TYPES.has(f.type) ? `${t} | Range<${baseType(f)}>` : t;
}

/**
 * Union of index prefixes: each member fixes a prefix of one index (the last key may be a Range) and
 * forbids every other indexed key with `?: never`, so tsc rejects keys outside the prefix and `{}`.
 */
function whereType(entity: Entity, indent: string): string {
  const indexes = entityIndexes(entity);
  const allKeys = [...new Set(indexes.flat())];
  const members = new Map<string, string>();
  for (const idx of indexes) {
    for (let k = 1; k <= idx.length; k++) {
      const prefix = idx.slice(0, k);
      const parts = prefix.map((key, i) => `${key}: ${whereKeyType(entity, key, i === k - 1)}`);
      for (const other of allKeys) if (!prefix.includes(other)) parts.push(`${other}?: never`);
      const key = [...prefix].sort().join(",") + (k === idx.length ? "" : `<${idx.join(",")}`);
      const text = `{ ${parts.join("; ")} }`;
      if (![...members.values()].includes(text)) members.set(key, text);
    }
  }
  return [...members.values()].map((m) => `\n${indent}  | ${m}`).join("");
}

function entityType(spec: AppSpec, entity: Entity, indent: string): string {
  const hidden = hiddenSomewhere(spec, entity.name);
  const doc = entity.fields.map((f) => `${comment(f.label)} ${f.name}: ${valueType(f)};`);
  const insert = entity.fields.map((f) => {
    const optional = !f.required || f.default !== undefined || f.type === "qr_token";
    return `${f.name}${optional ? "?" : ""}: ${valueType(f)};`;
  });
  const clientDoc = entity.fields.map((f) => `${f.name}${hidden.has(f.name) ? "?" : ""}: ${valueType(f)};`);
  const unique = uniqueFields(entity);
  const i2 = `${indent}  `;
  return [
    `${comment(entity.label)}`,
    `${indent}${entity.name}: {`,
    `${i2}doc: ${obj(doc, i2)};`,
    `${i2}insert: ${obj(insert, i2)};`,
    `${i2}clientDoc: ${obj(clientDoc, i2)};`,
    `${i2}where:${whereType(entity, i2)};`,
    `${i2}unique: ${unique.length ? unique.map((u) => JSON.stringify(u)).join(" | ") : "never"};`,
    `${indent}};`,
  ].join("\n");
}

function paymentBindings(config: Record<string, unknown> | undefined): string[] {
  const bindings = config?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings
    .map((b) => (b && typeof b === "object" ? (b as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

export function generateTypes(spec: AppSpec, opts: GenerateTypesOptions = {}): string {
  const base = opts.importBase ?? "../";
  const ind = "    ";
  const imports = new Set<string>(["Id", "Range"]);
  if (spec.entities.some((e) => e.fields.some((f) => f.type === "json"))) imports.add("Json");
  const integrations = spec.integrations ?? [];
  for (const i of integrations) {
    const t = CONNECTOR_TYPES[i.connector];
    if (t) imports.add(t);
  }

  const roles = spec.roles.map((r) => `${r.name}: true;`);
  const entities = spec.entities.map((e) => `${ind}${entityType(spec, e, ind)}`);
  const functions = (spec.functions ?? []).map(
    (f) => `${f.name}: typeof import(${JSON.stringify(base + f.file.replace(/\.ts$/, ""))}).default;`,
  );
  const connectors = integrations
    .filter((i) => CONNECTOR_TYPES[i.connector])
    .map((i) => `${i.name}: ${CONNECTOR_TYPES[i.connector]};`);
  const payments = integrations
    .filter((i) => i.connector === "yookassa")
    .map((i) => {
      const ids = paymentBindings(i.config);
      return `${i.name}: ${ids.length ? ids.map((id) => JSON.stringify(id)).join(" | ") : "never"};`;
    });

  const block = (name: string, members: string[]) => `  interface ${name} ${obj(members, "  ")}`;
  return [
    "// Generated by @wizard/sdk/codegen generateTypes(spec). Do not edit.",
    `import type { ${[...imports].sort().join(", ")} } from "@wizard/sdk";`,
    "",
    'declare module "@wizard/sdk" {',
    block("Roles", roles),
    `  interface Entities {\n${entities.join("\n")}\n  }`,
    block("Functions", functions),
    block("Connectors", connectors),
    block("Payments", payments),
    "}",
    "",
  ].join("\n");
}
