// import_mapping (workflows.yaml#import_table step map): only a SyntheticPayload is sent, with containsPiiHint=false;
// the router still runs DLP and sends anything with findings to T0 (data-boundary.yaml#routing.constraints).
import { isSyntheticPayload, type SyntheticPayload } from "@wizard/pii/import";
import { LlmError } from "./errors.js";
import type { Router } from "./router.js";
import type { LlmMessage, LlmTool, OrgPolicy, RouteContext, RouteOutput } from "./types.js";

/** api.yaml#ImportColumnMapping plus the sheet the column belongs to. */
export interface ImportColumnMapping {
  sheet: string;
  column: string;
  action: "map" | "skip" | "new_field";
  entity?: string;
  field?: string;
  pii?: "none" | "basic";
}

/** Target entities of the system (names, labels and field types only — never data). */
export interface ImportEntityRef {
  name: string;
  label?: string;
  fields: { name: string; type: string; label?: string }[];
}

export const IMPORT_MAPPING_TOOL: LlmTool = {
  name: "propose_mapping",
  description:
    "Map every column of the imported table to an entity field (map), a new field (new_field) or skip it. Use sheet and column names exactly as given.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["mappings"],
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sheet", "column", "action"],
          properties: {
            sheet: { type: "string" },
            column: { type: "string" },
            action: { enum: ["map", "skip", "new_field"] },
            entity: { type: "string" },
            field: { type: "string" },
            pii: { enum: ["none", "basic"] },
          },
        },
      },
    },
  },
};

const SYSTEM = [
  "You map columns of a user's spreadsheet onto the entities of an app.",
  "You see only column profiles and synthetic example rows, never real data; [ФИО_1]-style tokens are placeholders.",
  "Call propose_mapping once with one item per column. Prefer existing entity fields with a compatible type;",
  "use new_field (with a snake_case latin field name) only when nothing fits; skip empty or technical columns.",
  "Set pii=basic for columns with personal data (piiKindGuess or placeholders).",
].join(" ");

export function importMappingMessages(
  payload: SyntheticPayload,
  entities: readonly ImportEntityRef[] = [],
): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify({ table: payload, entities }) },
  ];
}

export interface ImportMappingInput {
  payload: SyntheticPayload;
  entities?: readonly ImportEntityRef[];
  orgPolicy?: OrgPolicy | null;
  ctx: RouteContext;
  signal?: AbortSignal;
}

export interface ImportMappingOutput
  extends Pick<
    RouteOutput,
    "tier" | "model" | "routeReason" | "scrubbed" | "ruFallback" | "usage" | "creditsCharged" | "creditsMilli"
  > {
  /** One item per payload column, in payload order. */
  mapping: ImportColumnMapping[];
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

function normalize(
  payload: SyntheticPayload,
  entities: readonly ImportEntityRef[],
  args: unknown,
): ImportColumnMapping[] {
  const raw = (args as { mappings?: unknown } | null)?.mappings;
  const proposals = Array.isArray(raw) ? raw : [];
  const known = new Map(entities.map((e) => [e.name, new Set(e.fields.map((f) => f.name))]));
  const out: ImportColumnMapping[] = [];
  for (const sheet of payload.sheets) {
    for (const col of sheet.columns) {
      const p = proposals.find(
        (x): x is Record<string, unknown> =>
          typeof x === "object" && x !== null && x.sheet === sheet.name && x.column === col.header,
      );
      // Personal data flagged by either side is kept (the user confirms it on S-import).
      const pii: "none" | "basic" = col.piiKindGuess !== null || p?.pii === "basic" ? "basic" : "none";
      const item: ImportColumnMapping = { sheet: sheet.name, column: col.header, action: "skip", pii };
      if (p?.action === "map" && isStr(p.entity) && isStr(p.field) && known.get(p.entity)?.has(p.field)) {
        Object.assign(item, { action: "map", entity: p.entity, field: p.field });
      } else if (
        p?.action === "new_field" &&
        isStr(p.entity) &&
        isStr(p.field) &&
        /^[a-z][a-z0-9_]{0,62}$/.test(p.field)
      ) {
        Object.assign(item, { action: "new_field", entity: p.entity, field: p.field });
      }
      out.push(item);
    }
  }
  return out;
}

/** The import_mapping LLM call. Refuses anything that is not a SyntheticPayload built by @wizard/pii/import. */
export async function routeImportMapping(
  router: Pick<Router, "route">,
  input: ImportMappingInput,
): Promise<ImportMappingOutput> {
  if (!isSyntheticPayload(input.payload)) {
    throw new LlmError(
      "IMPORT_PAYLOAD_NOT_SYNTHETIC",
      "Для сопоставления колонок можно передать только обезличенный профиль таблицы.",
    );
  }
  const entities = input.entities ?? [];
  const out = await router.route({
    callType: "import_mapping",
    messages: importMappingMessages(input.payload, entities),
    tools: [IMPORT_MAPPING_TOOL],
    toolChoice: "required",
    containsPiiHint: false,
    ...(input.orgPolicy !== undefined ? { orgPolicy: input.orgPolicy } : {}),
    ctx: input.ctx,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const call = out.result.toolCalls.find((t) => t.name === IMPORT_MAPPING_TOOL.name);
  return {
    tier: out.tier,
    model: out.model,
    routeReason: out.routeReason,
    scrubbed: out.scrubbed,
    ruFallback: out.ruFallback,
    usage: out.usage,
    creditsCharged: out.creditsCharged,
    creditsMilli: out.creditsMilli,
    mapping: normalize(input.payload, entities, call?.args),
  };
}
