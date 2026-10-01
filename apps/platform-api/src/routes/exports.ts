// M2-10 data export (api.yaml#createExport, #listExports, #getExport; workflows.yaml#workflows.export_data; L4-08, L3-37).
// Owner only. The archive is downloaded by a single-use link (15 min) that also needs the owner's session.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { type Selectable, sql } from "kysely";
import { z } from "zod";
import type { ExportsTable, SystemsTable } from "../db/types.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { EXPORT_LINK_TTL_MS, EXPORT_TTL_MS, ExportStore } from "../exports/storage.js";
import type { ExportRunInput } from "../exports/workflow.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { withTx } from "../runs/events.js";
import { insertRun, TERMINAL_STATUSES } from "../runs/queue.js";
import { toRun } from "../services/serialize.js";

/** Exports per system in 24 h (disk and DB load guard). */
export const EXPORTS_PER_DAY = 20;

const createSchema = z.strictObject({
  env: z.enum(["draft", "prod"]),
  includePii: z.boolean().optional(),
});

type ExportRow = Selectable<ExportsTable> & { run_status: string | null; include_pii: string | null };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Status as the client sees it: a running export of a finished run failed; a ready one past its TTL expired. */
function effectiveStatus(r: ExportRow, now = Date.now()): string {
  if (r.status === "running" && r.run_status && TERMINAL_STATUSES.has(r.run_status)) return "failed";
  if (r.status === "ready" && r.expires_at.getTime() <= now) return "expired";
  return r.status;
}

function toExport(r: ExportRow) {
  return {
    id: r.id,
    env: r.env,
    status: effectiveStatus(r),
    size: r.size === null ? null : Number(r.size),
    downloads: r.downloads,
    expiresAt: r.expires_at.toISOString(),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    includePii: r.include_pii === "true",
  };
}

export function exportRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const store = new ExportStore(d.config.artifactsDir, d.config.secretsKey);

  /** Owner of the system's org (api.yaml x-roles: [owner]); another org's system → 404. */
  async function loadSystem(user: AuthUser, id: string | undefined): Promise<Selectable<SystemsTable>> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "owner", "Система", "NOT_OWNER");
    return s;
  }

  const rows = (systemId: string) =>
    d.db
      .selectFrom("platform.exports as e")
      .leftJoin("platform.runs as r", "r.id", "e.run_id")
      .selectAll("e")
      .select(["r.status as run_status", sql<string | null>`r.input->>'includePii'`.as("include_pii")])
      .where("e.system_id", "=", systemId);

  async function loadExport(systemId: string, id: string | undefined): Promise<ExportRow> {
    if (!isUuid(id)) throw notFound("Выгрузка");
    const row = await rows(systemId).where("e.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("Выгрузка");
    return row;
  }

  // createExport
  r.post("/systems/:id/exports", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"));
    const b = await jsonBody(c, createSchema);
    if (b.env === "prod" && s.prod_revision === null)
      throw new ApiError("PREVIEW_NOT_READY", "Система ещё не опубликована: в рабочей версии нет данных");
    if (b.env === "draft" && s.preview_revision === null)
      throw new ApiError("PREVIEW_NOT_READY", "Черновик системы ещё не собран");
    const recent = await d.db
      .selectFrom("platform.exports")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("system_id", "=", s.id)
      .where("created_at", ">", new Date(Date.now() - 24 * 3600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= EXPORTS_PER_DAY)
      throw new ApiError("RATE_LIMITED", "Слишком много выгрузок за сутки. Попробуйте позже.");
    const exportId = randomUUID();
    const input: ExportRunInput = { exportId, env: b.env, includePii: b.includePii === true };
    const run = await withTx(d.db, d.bus, async (t) => {
      // Export costs nothing: inserted without billing (no hold).
      const run = await insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "export",
        input: input as unknown as Record<string, unknown>,
        startedBy: user.id,
      });
      await t.trx
        .insertInto("platform.exports")
        .values({
          id: exportId,
          system_id: s.id,
          env: b.env,
          run_id: run.id,
          status: "running",
          expires_at: new Date(Date.now() + EXPORT_TTL_MS),
          created_by: user.id,
        })
        .execute();
      return run;
    });
    d.engine.enqueue(run);
    return c.json({ exportId, run: toRun(run, 0) }, 202);
  });

  // listExports — the export journal: who, when, env, downloads
  r.get("/systems/:id/exports", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const list = await rows(s.id).orderBy("e.created_at", "desc").limit(100).execute();
    return c.json({ items: list.map(toExport) });
  });

  // getExport — status; a ready one gets a fresh single-use link (the previous link stops working)
  r.get("/systems/:id/exports/:exportId", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const row = await loadExport(s.id, c.req.param("exportId"));
    let downloadUrl: string | null = null;
    if (effectiveStatus(row) === "ready") {
      const token = randomBytes(32).toString("base64url");
      await d.db
        .updateTable("platform.exports")
        .set({
          download_token_hash: sha256(token),
          download_token_expires_at: new Date(Date.now() + EXPORT_LINK_TTL_MS),
        })
        .where("id", "=", row.id)
        .execute();
      downloadUrl = `${d.config.platformOrigin}/api/v1/systems/${s.id}/exports/${row.id}/download?token=${token}`;
    }
    return c.json({ ...toExport(row), downloadUrl });
  });

  // Archive download by the single-use link (not in api.yaml: the URL is what getExport returns as downloadUrl).
  r.get("/systems/:id/exports/:exportId/download", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const exportId = c.req.param("exportId");
    if (!isUuid(exportId)) throw notFound("Выгрузка");
    const token = c.req.query("token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid("Некорректная ссылка на выгрузку");
    const used = await d.db
      .updateTable("platform.exports")
      .set((eb) => ({
        downloads: eb("downloads", "+", 1),
        download_token_hash: null,
        download_token_expires_at: null,
      }))
      .where("id", "=", exportId)
      .where("system_id", "=", s.id)
      .where("status", "=", "ready")
      .where("download_token_hash", "=", sha256(token))
      .where("download_token_expires_at", ">", new Date())
      .where("expires_at", ">", new Date())
      .returning(["id", "env", "created_at"])
      .executeTakeFirst();
    if (!used) {
      await loadExport(s.id, exportId);
      throw new ApiError("EXPORT_LINK_USED", "Ссылка уже использована или истекла. Получите новую ссылку.");
    }
    let file: Awaited<ReturnType<ExportStore["open"]>>;
    try {
      file = await store.open(used.id);
    } catch {
      throw new ApiError("EXPORT_LINK_USED", "Архив выгрузки удалён. Запустите выгрузку снова.");
    }
    const date = used.created_at.toISOString().slice(0, 10);
    return c.body(Readable.toWeb(file.stream) as unknown as ReadableStream, 200, {
      "content-type": "application/zip",
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="wizard-export-${used.env}-${date}.zip"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  });

  return r;
}
