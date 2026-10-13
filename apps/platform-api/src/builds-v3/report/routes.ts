// V4-04: the reports of builds for staff — GET /admin/runs/:id/report (JSON, ?format=md — Markdown) and its files
// (screenshots, the records of the model calls). Staff only, as the other /admin routes (staffGuard).
import type { FileStorage } from "@wizard/runtime";
import { Hono } from "hono";
import { type StaffDeps, staffGuard } from "../../abuse/staff.js";
import { notFound } from "../../errors.js";
import type { AppEnv } from "../../http/auth.js";
import { renderReportMd } from "./render.js";
import { loadBuildReport, reportFile } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function reportRoutes(d: StaffDeps & { files: () => FileStorage; origin: string }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);
  const load = async (id: string) => {
    if (!UUID.test(id)) throw notFound("Отчёт");
    const report = await loadBuildReport(d.files(), id);
    if (!report) throw notFound("Отчёт");
    return report;
  };

  r.get("/admin/runs/:id/report", staff, async (c) => {
    const report = await load(c.req.param("id"));
    if (c.req.query("format") === "md")
      return c.text(renderReportMd(report, `${d.origin}/api/v1/admin/runs/${report.runId}/report`), 200, {
        "content-type": "text/markdown; charset=utf-8",
      });
    return c.json(report);
  });

  r.get("/admin/runs/:id/report/files/:schema/:file", staff, async (c) => {
    const report = await load(c.req.param("id"));
    const f = await reportFile(d.files(), report, `${c.req.param("schema")}/${c.req.param("file")}`);
    if (!f) throw notFound("Файл");
    return c.body(new Uint8Array(f.data).buffer as ArrayBuffer, 200, {
      "content-type": f.mime,
      "cache-control": "private, max-age=3600",
    });
  });
  return r;
}
