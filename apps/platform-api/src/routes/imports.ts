// M1-07 table import (api.yaml#createImport, #getImport, #updateImportMapping; workflows.yaml#import_table).
// The file is validated here (limits → 413), stored encrypted with a 7-day TTL and handled by an import_table run.
import { randomUUID } from "node:crypto";
import { ImportError, readTable } from "@wizard/pii/import";
import { Hono } from "hono";
import { type Selectable, sql } from "kysely";
import { z } from "zod";
import { json } from "../db/index.js";
import type { ImportsTable, SystemsTable } from "../db/types.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { type ApiMapping, apiProfile, normalizeMapping, type ProfileItem } from "../imports/columns.js";
import { IMPORT_TTL_MS, ImportStore } from "../imports/storage.js";
import type { ImportRunInput } from "../imports/workflow.js";
import { withTx } from "../runs/events.js";
import { insertRun, TERMINAL_STATUSES } from "../runs/queue.js";
import { loadSpec } from "../services/revisions.js";
import { toRun } from "../services/serialize.js";

const MAX_FILE = 20 * 1024 * 1024;
const ACTIVE = new Set(["profiling", "mapping", "awaiting_confirm", "importing"]);

const mappingSchema = z.strictObject({
  mapping: z
    .array(
      z.strictObject({
        column: z.string().min(1).max(300),
        action: z.enum(["map", "skip", "new_field"]),
        entity: z.string().min(1).max(63).optional(),
        field: z.string().min(1).max(63).optional(),
        pii: z.enum(["none", "basic"]).optional(),
      }),
    )
    .max(2000),
});

function importError(e: ImportError): ApiError {
  if (e.httpStatus === 413) return new ApiError("PAYLOAD_TOO_LARGE", e.message, { reason: e.code });
  if (e.code === "UNSUPPORTED_FORMAT")
    return new ApiError("UNSUPPORTED_MEDIA_TYPE", e.message, { reason: e.code });
  return invalid(e.message, { reason: e.code });
}

export function importRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const store = new ImportStore(d.config.importsDir, d.config.secretsKey);

  /** Editor+ of the system's org (api.yaml x-roles: [editor]); another org's system → 404. */
  async function loadSystem(user: AuthUser, id: string | undefined): Promise<Selectable<SystemsTable>> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "editor", "Система");
    return s;
  }

  async function loadImport(systemId: string, id: string | undefined): Promise<Selectable<ImportsTable>> {
    if (!isUuid(id)) throw notFound("Импорт");
    const row = await d.db
      .selectFrom("platform.imports")
      .selectAll()
      .where("id", "=", id)
      .where("system_id", "=", systemId)
      .executeTakeFirst();
    if (!row) throw notFound("Импорт");
    return row;
  }

  // createImport
  r.post("/systems/:id/imports", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"));
    if (Number(c.req.header("content-length") ?? 0) > MAX_FILE + 1_048_576)
      throw new ApiError("PAYLOAD_TOO_LARGE", "Файл слишком большой: можно загрузить до 20 МБ");
    if (s.preview_revision === null)
      throw new ApiError("PREVIEW_NOT_READY", "Загрузить таблицу можно после первой сборки системы");
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw invalid("Ожидается multipart/form-data с файлом");
    }
    const file = form.file;
    if (!(file instanceof File)) throw invalid("Нет файла таблицы");
    if (file.size > MAX_FILE)
      throw new ApiError("PAYLOAD_TOO_LARGE", "Файл слишком большой: можно загрузить до 20 МБ");
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Only the extension is kept: a file name may carry personal data («Клиенты Иванова.xlsx»).
    const ext = /\.(xlsx|csv|txt|xls|xlsb|ods)$/i.exec(file.name)?.[1]?.toLowerCase();
    const filename = ext ? `table.${ext}` : undefined;
    try {
      const table = readTable(bytes, filename ? { filename } : {});
      if (!table.sheets.some((sh) => sh.header.length > 0)) throw invalid("В таблице нет ни одной колонки");
    } catch (e) {
      if (e instanceof ImportError) throw importError(e);
      throw e;
    }
    const importId = randomUUID();
    const sha = await store.put(importId, bytes);
    try {
      const run = await withTx(d.db, d.bus, async (t) => {
        await t.trx
          .insertInto("platform.imports")
          .values({
            id: importId,
            system_id: s.id,
            source_sha: sha,
            status: "profiling",
            expires_at: new Date(Date.now() + IMPORT_TTL_MS),
            created_by: user.id,
          })
          .execute();
        const input: ImportRunInput = { importId, ...(filename ? { filename } : {}) };
        return insertRun(t, {
          orgId: s.org_id,
          systemId: s.id,
          kind: "import_table",
          input: input as unknown as Record<string, unknown>,
          startedBy: user.id,
        });
      });
      d.engine.enqueue(run);
      return c.json({ importId, run: toRun(run, 0) }, 202);
    } catch (e) {
      await store.remove(importId);
      throw e;
    }
  });

  // getImport
  r.get("/systems/:id/imports/:importId", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const row = await loadImport(s.id, c.req.param("importId"));
    const run = await d.db
      .selectFrom("platform.runs")
      .select(["id", "status", "pending_input"])
      .where("system_id", "=", s.id)
      .where("kind", "=", "import_table")
      .where(sql<boolean>`input->>'importId' = ${row.id}`)
      .executeTakeFirst();
    const pending = run?.pending_input as { inputId?: string; decisionId?: string } | null | undefined;
    // A run that ended without finishing the import (cancel, restart) leaves the import failed.
    const status = ACTIVE.has(row.status) && run && TERMINAL_STATUSES.has(run.status) ? "failed" : row.status;
    return c.json({
      id: row.id,
      status,
      runId: run?.id ?? null,
      inputId:
        run?.status === "needs_input" && pending?.decisionId === "import_confirm"
          ? (pending.inputId ?? null)
          : null,
      profile: apiProfile((row.profile as ProfileItem[] | null) ?? []),
      mapping: (row.mapping as ApiMapping[] | null) ?? [],
      rowsImported: row.rows_imported,
    });
  });

  // updateImportMapping
  r.put("/systems/:id/imports/:importId/mapping", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const b = await jsonBody(c, mappingSchema);
    const row = await loadImport(s.id, c.req.param("importId"));
    if (row.status !== "awaiting_confirm")
      throw new ApiError(
        "RUN_NOT_WAITING_INPUT",
        "Сопоставление можно менять только до подтверждения импорта",
      );
    if (s.preview_revision === null) throw new ApiError("PREVIEW_NOT_READY", "Система ещё не собрана");
    const spec = await loadSpec(d.db, s, s.preview_revision);
    const { mapping, problems } = normalizeMapping(
      (row.profile as ProfileItem[] | null) ?? [],
      spec,
      b.mapping as ApiMapping[],
    );
    if (problems.length > 0)
      throw new ApiError("OPS_INVALID", "Сопоставление не сохранено: исправьте колонки", { problems });
    const upd = await d.db
      .updateTable("platform.imports")
      .set({ mapping: json(mapping) })
      .where("id", "=", row.id)
      .where("status", "=", "awaiting_confirm")
      .executeTakeFirst();
    if (Number(upd.numUpdatedRows) === 0)
      throw new ApiError("RUN_NOT_WAITING_INPUT", "Импорт уже подтверждён или отменён");
    return c.json({ mapping });
  });

  return r;
}
