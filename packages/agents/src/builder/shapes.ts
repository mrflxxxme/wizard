// Exact shapes of the AppSpec objects for the builder's prompt, printed from the zod schemas of @wizard/appspec (the
// validator itself), so the reference and the checks never drift. The ops list (PROMPT_PARTS.ops) names the
// operations; this names what goes inside them: field, entity, role, permission, workflow, integration, function,
// page, acceptance, compliance.
import {
  acceptanceSchema,
  complianceSchema,
  entitySchema,
  fieldSchema,
  functionSchema,
  IDENT_RE,
  indexSchema,
  integrationSchema,
  pageSchema,
  permissionSchema,
  retentionSchema,
  roleSchema,
  workflowSchema,
} from "@wizard/appspec";

interface Def {
  type: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  entries?: Record<string, string>;
  values?: unknown[];
  options?: unknown[];
  valueType?: unknown;
  checks?: { _zod: { def: { check: string; pattern?: RegExp; minimum?: number; maximum?: number } } }[];
  in?: unknown;
}

const NAMED: [unknown, string][] = [
  [fieldSchema, "Field"],
  [indexSchema, "Index"],
  [retentionSchema, "Retention"],
];

const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

function bounds(d: Def): string {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of d.checks ?? []) {
    const k = c._zod.def;
    if (k.check === "min_length" || k.check === "greater_than") min = k.minimum ?? min;
    if (k.check === "max_length" || k.check === "less_than") max = k.maximum ?? max;
  }
  if (min === undefined && max === undefined) return "";
  return `(${min ?? ""}..${max ?? ""})`;
}

/** TS-like one-line type of a zod schema. */
export function shapeOf(s: unknown, top = false): string {
  if (!top) for (const [n, name] of NAMED) if (n === s) return name;
  const d = defOf(s);
  switch (d.type) {
    case "object":
      return `{${Object.entries(d.shape ?? {})
        .map(([k, v]) => {
          const opt = defOf(v).type === "optional";
          return `${k}${opt ? "?" : ""}: ${shapeOf(opt ? defOf(v).innerType : v)}`;
        })
        .join(", ")}}`;
    case "optional":
      return shapeOf(d.innerType);
    case "array": {
      const el = shapeOf(d.element);
      return `${el.includes("|") && !el.startsWith("{") ? `(${el})` : el}[]${bounds(d)}`;
    }
    case "enum":
      return Object.values(d.entries ?? {})
        .map((v) => JSON.stringify(v))
        .join("|");
    case "literal":
      return (d.values ?? []).map((v) => JSON.stringify(v)).join("|");
    case "union":
      return (d.options ?? []).map((o) => shapeOf(o)).join("|");
    case "string": {
      const re = d.checks?.map((c) => c._zod.def.pattern).find(Boolean);
      if (re && re.source === IDENT_RE.source) return "ident";
      return re ? `str /${re.source}/` : `str${bounds(d)}`;
    }
    case "number":
      return `num${bounds(d)}`;
    case "boolean":
      return "bool";
    case "record":
      return defOf(d.valueType).type === "unknown" ? "object" : `{[key]: ${shapeOf(d.valueType)}}`;
    case "unknown":
    case "any":
      return "any";
    case "pipe":
      return shapeOf(d.in);
    default:
      return d.type;
  }
}

/** The reference block of the static prompt. */
export function specShapes(): string {
  const rows: [string, unknown][] = [
    ["Field", fieldSchema],
    ["Index", indexSchema],
    ["Retention", retentionSchema],
    ["Entity (add_entity)", entitySchema],
    ["Role (add_role)", roleSchema],
    ["Permission (set_permission)", permissionSchema],
    ["Workflow (add_workflow {workflow})", workflowSchema],
    ["Integration (add_integration {integration})", integrationSchema],
    ["Function (add_function)", functionSchema],
    ["Page (add_page)", pageSchema],
    ["Acceptance (set_acceptance {acceptance: Acceptance[]})", acceptanceSchema],
    ["Compliance (set_compliance)", complianceSchema],
  ];
  return [
    'Точные формы объектов (лишние ключи запрещены; ident = /^[a-z][a-z0-9_]{0,39}$/; label и title — 1..80 символов; ? — необязательный). Поля операции лежат прямо в ней рядом с op: {op: "add_entity", name, label, fields}; add_field — {op, entity, field: Field}; add_workflow — {op, workflow: Workflow}:',
    ...rows.map(([name, s]) => `- ${name}: ${shapeOf(s, true)}`),
  ].join("\n");
}
