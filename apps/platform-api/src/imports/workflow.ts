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
import { loadRows, planLoad } from "./load.js";
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
  /**
   * A checkpoint (M1: DBOS step; identity in-process) for reads that steer the flow and writes outside steps. Cell
   * values never go through it: the table is re-read from the import store after a restart.
   */
  once<T>(name: string, fn: () => Promise<T>): Promise<T>;
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
    const row = await h.once("import_row", async () => {
      const r = await h.db
        .selectFrom("platform.imports")
        .select(["source_sha", "status", "expires_at"])
        .where("id", "=", importId)
        .executeTakeFirstOrThrow();
      return {
        sourceSha: r.source_sha,
        expired: r.status === "expired" || r.expires_at.getTime() <= Date.now(),
      };
    });
    if (row.expired)
      throw new RunFailure("INTERNAL", "Файл импорта удалён по сроку хранения — загрузите его снова");

    const { table, payload, items } = await h.step("profile", "Читаю таблицу", async () => {
      // Read from the encrypted import store on every execution (also when a restarted worker replays the run).
      const file = await h.store.get(importId, row.sourceSha);
      const table = readTable(file, h.run.input.filename ? { filename: h.run.input.filename } : {});
      // Seed from the file hash: the same file gives the same payload (stable fixture keys, WIZARD_LLM_MODE=fixture).
      const payload = buildMappingPayload(table, { seed: Number.parseInt(row.sourceSha.slice(0, 8), 16) });
      const items = profileItems(profileTable(table), payload);
      await h.once("profile_saved", () => setImport(h, { profile: json(items), status: "mapping" }));
      return { table, payload, items };
    });

    await h.step("map", "Сопоставляю колонки", async () => {
      const spec = await h.once("map_spec", async () => (await preview(h)).spec);
      const out = await routeImportMapping(
        { route: hostRouteFn((i) => h.route(i), { step: "map" }) },
        { payload, entities: entitiesOf(spec), ctx: { orgId: h.run.orgId } },
      );
      // Checkpointed, and only from status mapping: a replay — also a re-run after a crash between this write and
      // its checkpoint — must not overwrite the mapping the user edited while the run waited.
      await h.once("mapping_saved", async () => {
        await h.db
          .updateTable("platform.imports")
          .set({ mapping: json(fromLlm(items, out.mapping)), status: "awaiting_confirm" })
          .where("id", "=", importId)
          .where("status", "=", "mapping")
          .execute();
      });
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
    let mapping = await h.once("confirmed_mapping", async () => {
      const confirmed = await h.db
        .selectFrom("platform.imports")
        .select("mapping")
        .where("id", "=", importId)
        .executeTakeFirstOrThrow();
      await setImport(h, { status: "importing" });
      return (confirmed.mapping as ApiMapping[] | null) ?? [];
    });

    let resultRevision: number | null = null;
    const newFields = mapping.filter((m) => m.action === "new_field" && m.entity && m.field);
    if (newFields.length > 0) {
      await h.step("schema_ops", "Добавляю поля для колонок таблицы", async () => {
        const before = await h.once("schema_before", async () => {
          const { sys } = await preview(h);
          return { revision: sys.preview_revision, card: sys.card as Record<string, unknown> | null };
        });
        await h.buildChange(changeCard(before.card, items, newFields), 10);
        const after = await h.once("schema_after", async () => {
          const a = await preview(h);
          return { revision: a.revision, spec: a.spec };
        });
        if (after.revision !== before.revision) resultRevision = after.revision;
        mapping = mapping.map((m) => {
          if (m.action !== "new_field") return m;
          const p = items.find((x) => x.column === m.column) as ProfileItem;
          const label = /^col_\d+$/.test(p.payloadColumn) ? `Колонка ${p.index + 1}` : p.payloadColumn;
          const field = resolveNewField(after.spec, m, label);
          return field ? { ...m, action: "map", field } : { ...m, action: "skip" };
        });
      });
    }

    const loaded = await h.step("load_rows", "Загружаю строки в черновик", () =>
      h.once("load_rows", async () => {
        const { sys, spec } = await preview(h);
        const input = {
          schema: schemaName(sys.schema_key, "draft"),
          spec,
          table,
          payload,
          mapping: toLoad(items, mapping),
          ...(h.migratorRole ? { migratorRole: h.migratorRole } : {}),
        };
        const cur = await h.db
          .selectFrom("platform.imports")
          .select("status")
          .where("id", "=", importId)
          .executeTakeFirstOrThrow();
        // Loaded before a crash that lost this checkpoint: the rows are in, only the counts are recomputed.
        if (cur.status === "done") return planLoad(input).result;
        return loadRows(h.pg, input, {
          // In the insert transaction: the import is done exactly when its rows are committed.
          before: async (tx, r) => {
            await tx`
              update platform.imports set rows_imported = ${r.rowsImported}, status = 'done'
              where id = ${importId} and status <> 'expired'`;
          },
        });
      }),
    );
    const skipped =
      loaded.rowsSkipped > 0 ? `, пропущено ${loaded.rowsSkipped} (не заполнены обязательные поля)` : "";
    return { summary_ru: `Импортировано строк: ${loaded.rowsImported}${skipped}`, resultRevision };
  } catch (e) {
    await h.once("import_failed", () => setImport(h, { status: "failed" })).catch(() => {});
    throw e;
  }
}
