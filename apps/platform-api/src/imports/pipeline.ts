// import_table steps profile → map (workflows.yaml#import_table): the file is parsed and profiled locally; the LLM
// sees only buildMappingPayload() output (data-boundary.yaml#import). confirm and load_rows follow (load.ts).
import type { AppSpec } from "@wizard/appspec";
import {
  type ImportColumnMapping,
  type ImportEntityRef,
  type OrgPolicy,
  type RouteContext,
  type Router,
  routeImportMapping,
} from "@wizard/llm";
import {
  buildMappingPayload,
  type ImportLimits,
  profileTable,
  readTable,
  type SheetProfile,
  type SyntheticPayload,
  type Table,
} from "@wizard/pii/import";

/** Entities of the spec as the mapper sees them: names, labels, field types — never data. */
export function entitiesOf(spec: AppSpec): ImportEntityRef[] {
  return spec.entities.map((e) => ({
    name: e.name,
    label: e.label,
    fields: e.fields.map((f) => ({ name: f.name, type: f.type, label: f.label })),
  }));
}

export interface ProposeImportInput {
  router: Pick<Router, "route">;
  file: Uint8Array;
  filename?: string;
  spec: AppSpec;
  orgPolicy: OrgPolicy | null;
  ctx: RouteContext;
  signal?: AbortSignal;
  limits?: Partial<ImportLimits>;
  /** Faker seed for the synthetic rows (tests). */
  seed?: number;
}

export interface ProposedImport {
  table: Table;
  /** For S-import (api.yaml#getImport): profiles without values. */
  profile: SheetProfile[];
  payload: SyntheticPayload;
  mapping: ImportColumnMapping[];
}

/** profile + map. Throws ImportError (413/400) for files over the limits. */
export async function proposeImport(i: ProposeImportInput): Promise<ProposedImport> {
  const table = readTable(i.file, {
    ...(i.filename !== undefined ? { filename: i.filename } : {}),
    ...(i.limits ? { limits: i.limits } : {}),
  });
  const profile = profileTable(table);
  const payload = buildMappingPayload(table, i.seed !== undefined ? { seed: i.seed } : {});
  const out = await routeImportMapping(i.router, {
    payload,
    entities: entitiesOf(i.spec),
    orgPolicy: i.orgPolicy,
    ctx: { ...i.ctx, step: i.ctx.step ?? "map" },
    ...(i.signal ? { signal: i.signal } : {}),
  });
  return { table, profile, payload, mapping: out.mapping };
}
