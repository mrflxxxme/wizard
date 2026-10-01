// export run (workflows.yaml#workflows.export_data): dump (+ sanitize per cell) → store. Rows are read in one
// REPEATABLE READ snapshot of app_<key>_<env> as the migrator with wizard.role = __system and streamed into a ZIP that
// is encrypted while it is written; nothing of the data is kept in memory beyond one cursor batch.
import { type AppSpec, quoteIdent, SYSTEM_ROLE } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import { Zip, ZipDeflate } from "fflate";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";
import type { Db } from "../db/index.js";
import { RunCancelled, RunFailure } from "../runs/types.js";
import { loadSpec } from "../services/revisions.js";
import { CSV_BOM, csvCell, csvRow, planExport, type TablePlan } from "./csv.js";
import { ExportStore, type ExportWriter } from "./storage.js";

const BATCH = 500;

export interface ExportRunInput {
  exportId: string;
  env: "draft" | "prod";
  /** Personal-data columns: only on the owner's explicit confirmation (POST /exports {includePii: true}). */
  includePii: boolean;
}

export interface ExportHost {
  run: { id: string; systemId: string; input: ExportRunInput };
  db: Db;
  pg: postgres.Sql;
  store: ExportStore;
  migratorRole?: string;
  signal?: AbortSignal;
  step<T>(name: string, label_ru: string, fn: () => Promise<T>): Promise<T>;
  log?: (msg: string, err?: unknown) => void;
}

export interface DumpResult {
  revision: number;
  rows: Record<string, number>;
  omittedPii: number;
  size: number;
}

/** fflate ZIP whose output chunks are collected until the next flush. */
class ZipSink {
  readonly #zip: Zip;
  #pending: Uint8Array[] = [];
  #error: Error | null = null;
  constructor() {
    this.#zip = new Zip((err, data) => {
      if (err) this.#error = err;
      else this.#pending.push(data);
    });
  }
  file(name: string): ZipDeflate {
    const f = new ZipDeflate(name, { level: 6 });
    this.#zip.add(f);
    return f;
  }
  end(): void {
    this.#zip.end();
  }
  take(): Uint8Array[] {
    if (this.#error) throw this.#error;
    const out = this.#pending;
    this.#pending = [];
    return out;
  }
}

const enc = new TextEncoder();

async function dumpTable(
  tx: postgres.TransactionSql,
  schema: string,
  plan: TablePlan,
  existing: Map<string, Set<string>>,
  zip: ZipSink,
  out: ExportWriter,
  signal?: AbortSignal,
): Promise<number> {
  const have = existing.get(plan.table);
  // Columns the spec describes but the schema does not have yet (draft behind the spec) are left out.
  const cols = have ? plan.columns.filter((c) => have.has(c.name)) : plan.columns;
  const file = zip.file(`${plan.table}.csv`);
  file.push(enc.encode(CSV_BOM + csvRow(cols.map((c) => csvCell(c.name)))));
  let count = 0;
  if (have && cols.length > 0) {
    const order = ["created_at", "id"].filter((c) => have.has(c));
    const query = `select ${cols
      .map((c) => `to_jsonb(${quoteIdent(c.name)}) #>> '{}' as ${quoteIdent(c.name)}`)
      .join(", ")} from ${quoteIdent(schema)}.${quoteIdent(plan.table)}${
      order.length > 0 ? ` order by ${order.map(quoteIdent).join(", ")}` : ""
    }`;
    for await (const rows of tx.unsafe(query).cursor(BATCH)) {
      if (signal?.aborted) throw new RunCancelled("Выгрузка отменена");
      let text = "";
      for (const r of rows) text += csvRow(cols.map((c) => csvCell(r[c.name] as string | null, c.numeric)));
      file.push(enc.encode(text));
      count += rows.length;
      await out.write(zip.take());
    }
  }
  file.push(new Uint8Array(0), true);
  await out.write(zip.take());
  return count;
}

/** dump: CSV per entity (+ users) and spec.json of the env's current revision into an encrypted ZIP. */
export async function dumpExport(
  pg: postgres.Sql,
  db: Db,
  i: {
    systemId: string;
    exportId: string;
    env: "draft" | "prod";
    includePii: boolean;
    store: ExportStore;
    migratorRole?: string;
    signal?: AbortSignal;
  },
): Promise<DumpResult> {
  const out = await i.store.create(i.exportId);
  try {
    const zip = new ZipSink();
    const result = await pg.begin("isolation level repeatable read, read only", async (tx) => {
      // The first statement fixes the snapshot: the revision and the rows are read from the same state.
      const [sys] = await tx<
        {
          id: string;
          name: string;
          schema_key: string;
          prod_revision: number | null;
          preview_revision: number | null;
        }[]
      >`select id, name, schema_key, prod_revision, preview_revision from platform.systems where id = ${i.systemId}`;
      if (!sys) throw new RunFailure("EXPORT_FAILED", "Система не найдена");
      const revision = i.env === "prod" ? sys.prod_revision : sys.preview_revision;
      if (revision === null)
        throw new RunFailure(
          "EXPORT_FAILED",
          i.env === "prod" ? "Система ещё не опубликована" : "Черновик системы ещё не собран",
        );
      const spec: AppSpec = await loadSpec(db, sys, revision);
      const schema = schemaName(sys.schema_key, i.env);
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(i.migratorRole ?? MIGRATOR_ROLE)}`);
      await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
      await tx.unsafe("select set_config('TimeZone', 'UTC', true)");
      const colRows = await tx<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns where table_schema = ${schema}`;
      const existing = new Map<string, Set<string>>();
      for (const r of colRows) {
        const s = existing.get(r.table_name) ?? new Set<string>();
        s.add(r.column_name);
        existing.set(r.table_name, s);
      }
      const plan = planExport(spec, { includePii: i.includePii });
      const rows: Record<string, number> = {};
      for (const t of plan.tables)
        rows[t.table] = await dumpTable(tx, schema, t, existing, zip, out, i.signal);
      return { revision, rows, omittedPii: plan.omittedPii, spec };
    });
    const specFile = zip.file("spec.json");
    specFile.push(enc.encode(`${JSON.stringify(result.spec, null, 2)}\n`), true);
    zip.end();
    await out.write(zip.take());
    const size = await out.finish();
    return { revision: result.revision, rows: result.rows, omittedPii: result.omittedPii, size };
  } catch (e) {
    await out.abort();
    throw e;
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export async function runExport(h: ExportHost): Promise<{ summary_ru: string }> {
  const { exportId, env, includePii } = h.run.input;
  try {
    const dump = await h.step("dump", "Выгружаю данные в CSV", () =>
      dumpExport(h.pg, h.db, {
        systemId: h.run.systemId,
        exportId,
        env,
        includePii,
        store: h.store,
        ...(h.migratorRole ? { migratorRole: h.migratorRole } : {}),
        ...(h.signal ? { signal: h.signal } : {}),
      }),
    );
    await h.step("store", "Сохраняю архив", async () => {
      const upd = await h.db
        .updateTable("platform.exports")
        .set({ status: "ready", storage_key: ExportStore.key(exportId), size: dump.size })
        .where("id", "=", exportId)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (Number(upd.numUpdatedRows) === 0) throw new RunFailure("EXPORT_FAILED", "Выгрузка уже недоступна");
    });
    const tables = Object.keys(dump.rows).length;
    const total = Object.values(dump.rows).reduce((a, b) => a + b, 0);
    const pii = includePii ? "с персональными данными" : dump.omittedPii > 0 ? "без персональных данных" : "";
    return {
      summary_ru: `Выгрузка ${env === "prod" ? "рабочей версии" : "черновика"} готова: ${tables} ${plural(
        tables,
        "таблица",
        "таблицы",
        "таблиц",
      )}, ${total} ${plural(total, "строка", "строки", "строк")}${pii ? `, ${pii}` : ""}`,
    };
  } catch (e) {
    await h.store.remove(exportId).catch(() => {});
    await h.db
      .updateTable("platform.exports")
      .set({ status: "failed" })
      .where("id", "=", exportId)
      .where("status", "=", "running")
      .execute()
      .catch(() => {});
    if (e instanceof RunFailure || e instanceof RunCancelled) throw e;
    h.log?.(`export ${exportId} failed`, e);
    throw new RunFailure("EXPORT_FAILED", "Не удалось выгрузить данные. Попробуйте ещё раз.", true);
  }
}
