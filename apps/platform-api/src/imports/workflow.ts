// import_table run (workflows.yaml#workflows.import_table): profile → map → confirm → schema_ops → load_rows.
// Cell values never leave this process except into app_<key>_draft; the mapper sees only the SyntheticPayload.
import { hostRouteFn } from "@wizard/agents/host";
import type { AppSpec } from "@wizard/appspec";
import { type RouteOutput, routeImportMapping } from "@wizard/llm";
import { buildMappingPayload, profileTable, readTable } from "@wizard/pii/import";
import { schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { type Db, json } from "../db/index.js";
import {
  type HostRouteInput,
  type InputAnswer,
  type InputRequest,
  RunCancelled,
  RunFailure,
} from "../runs/types.js";
import { loadSpec } from "../services/revisions.js";
import { type ApiMapping, fieldTypeFor, fromLlm, type ProfileItem, profileItems, toLoad } from "./columns.js";
import { loadRows } from "./load.js";
import { entitiesOf } from "./pipeline.js";
import type { ImportStore } from "./storage.js";

/** Credits cap of an import run: the mapping call plus a small schema change by the builder. */
export const IMPORT_CAP_MILLI = 15_000;

export interface ImportRunInput {
  importId: string;
  filename?: string;
}

export interface ImportHost {
  run: { id: string; orgId: string; systemId: string; input: ImportRunInput };
  db: Db;
  pg: postgres.Sql;
  store: ImportStore;
  migratorRole?: string;
  step<T>(name: string, label_ru: string, fn: () => Promise<T>): Promise<T>;
  route(input: HostRouteInput): Promise<RouteOutput>;
  needsInput(req: InputRequest): Promise<InputAnswer>;
  /** schema_ops: a change build by the builder (build_ops → applyOps → G0 → draft migration). */
  buildChange(card: Record<string, unknown>, capCredits: number): Promise<{ summary_ru?: string }>;
}

export interface ImportResult {
  summary_ru: string;
  resultRevision: number | null;
}

async function setImport(h: ImportHost, set: Record<string, unknown>): Promise<void> {
  await h.db
    .updateTable("platform.imports")
    .set(set)
    .where("id", "=", h.run.input.importId)
    .where("status", "!=", "expired")
    .execute();
}

async function preview(h: ImportHost) {
  const sys = await h.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", h.run.systemId)
    .executeTakeFirstOrThrow();
  if (sys.preview_revision === null)
    throw new RunFailure("INTERNAL", "Импорт доступен после первой сборки системы");
  const spec: AppSpec = await loadSpec(h.db, sys, sys.preview_revision);
  return { sys, spec, revision: sys.preview_revision };
}

/** new_field items → the builder card: the change the builder makes before load_rows (workflows.yaml schema_ops). */
function changeCard(
  card: Record<string, unknown> | null,
  items: readonly ProfileItem[],
  fields: readonly ApiMapping[],
) {
  const importFields = fields.map((m) => {
    const p = items.find((x) => x.column === m.column) as ProfileItem;
    const label = /^col_\d+$/.test(p.payloadColumn) ? `Колонка ${p.index + 1}` : p.payloadColumn;
    return { entity: m.entity, field: m.field, label, type: fieldTypeFor(p.typeGuess), pii: m.pii ?? "none" };
  });
  const list = importFields.map((f) => `${f.entity}.${f.field} (${f.label}, ${f.type})`).join(", ");
  return {
    ...(card ?? {}),
    kind: "change",
    summary: `Импорт таблицы: добавить поля ${list}. Поля с pii=basic — персональные данные. Остальное не менять.`,
    importFields,
    acceptance: (card?.acceptance as unknown[] | undefined) ?? [],
    roles: (card?.roles as unknown[] | undefined) ?? [],
  };
}

/** The field the builder created for a new_field item: same name, else the same label in that entity. */
function resolveNewField(spec: AppSpec, m: ApiMapping, label: string): string | null {
  const e = spec.entities.find((x) => x.name === m.entity);
  if (!e) return null;
  if (e.fields.some((f) => f.name === m.field)) return m.field ?? null;
  return e.fields.find((f) => f.label === label)?.name ?? null;
}

export async function runImportTable(h: ImportHost): Promise<ImportResult> {
  const importId = h.run.input.importId;
  try {
    const row = await h.db
      .selectFrom("platform.imports")
      .selectAll()
      .where("id", "=", importId)
      .executeTakeFirstOrThrow();
    if (row.status === "expired" || row.expires_at.getTime() <= Date.now())
      throw new RunFailure("INTERNAL", "Файл импорта удалён по сроку хранения — загрузите его снова");

    const { table, payload, items } = await h.step("profile", "Читаю таблицу", async () => {
      const file = await h.store.get(importId, row.source_sha);
      const table = readTable(file, h.run.input.filename ? { filename: h.run.input.filename } : {});
      // Seed from the file hash: the same file gives the same payload (stable fixture keys, WIZARD_LLM_MODE=fixture).
      const payload = buildMappingPayload(table, { seed: Number.parseInt(row.source_sha.slice(0, 8), 16) });
      const items = profileItems(profileTable(table), payload);
      await setImport(h, { profile: json(items), status: "mapping" });
      return { table, payload, items };
    });

    await h.step("map", "Сопоставляю колонки", async () => {
      const { spec } = await preview(h);
      const out = await routeImportMapping(
        { route: hostRouteFn((i) => h.route(i), { step: "map" }) },
        { payload, entities: entitiesOf(spec), ctx: { orgId: h.run.orgId } },
      );
      await setImport(h, { mapping: json(fromLlm(items, out.mapping)), status: "awaiting_confirm" });
    });

    const answer = await h.needsInput({
      decisionId: "import_confirm",
      prompt_ru: "Проверьте, куда попадут колонки таблицы, и подтвердите загрузку",
      options: [
        { id: "confirm", label: "Загрузить", recommended: true },
        { id: "cancel", label: "Отмена" },
      ],
    });
    if (answer.choice !== "confirm") throw new RunCancelled("Импорт отменён");
    const confirmed = await h.db
      .selectFrom("platform.imports")
      .select("mapping")
      .where("id", "=", importId)
      .executeTakeFirstOrThrow();
    let mapping = (confirmed.mapping as ApiMapping[] | null) ?? [];
    await setImport(h, { status: "importing" });

    let resultRevision: number | null = null;
    const newFields = mapping.filter((m) => m.action === "new_field" && m.entity && m.field);
    if (newFields.length > 0) {
      await h.step("schema_ops", "Добавляю поля для колонок таблицы", async () => {
        const { sys } = await preview(h);
        const before = sys.preview_revision;
        await h.buildChange(changeCard(sys.card as Record<string, unknown> | null, items, newFields), 10);
        const after = await preview(h);
        if (after.revision !== before) resultRevision = after.revision;
        mapping = mapping.map((m) => {
          if (m.action !== "new_field") return m;
          const p = items.find((x) => x.column === m.column) as ProfileItem;
          const label = /^col_\d+$/.test(p.payloadColumn) ? `Колонка ${p.index + 1}` : p.payloadColumn;
          const field = resolveNewField(after.spec, m, label);
          return field ? { ...m, action: "map", field } : { ...m, action: "skip" };
        });
      });
    }

    const loaded = await h.step("load_rows", "Загружаю строки в черновик", async () => {
      const { sys, spec } = await preview(h);
      const r = await loadRows(h.pg, {
        schema: schemaName(sys.schema_key, "draft"),
        spec,
        table,
        payload,
        mapping: toLoad(items, mapping),
        ...(h.migratorRole ? { migratorRole: h.migratorRole } : {}),
      });
      await setImport(h, { rows_imported: r.rowsImported, status: "done" });
      return r;
    });
    const skipped =
      loaded.rowsSkipped > 0 ? `, пропущено ${loaded.rowsSkipped} (не заполнены обязательные поля)` : "";
    return { summary_ru: `Импортировано строк: ${loaded.rowsImported}${skipped}`, resultRevision };
  } catch (e) {
    await setImport(h, { status: "failed" }).catch(() => {});
    throw e;
  }
}
