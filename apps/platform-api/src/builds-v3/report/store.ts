// V4-04: reports in the shared file storage (S3 on the platform): the report JSON under wz_reports/<runId>, its
// screenshots and the records of the build's model calls under wz_reports/<uuid>.
import { randomUUID } from "node:crypto";
import type { FileMeta, FileStorage } from "@wizard/runtime";
import type { BuildReport } from "./types.js";

export const REPORTS_SCHEMA = "wz_reports";

const meta = (name: string, mime: FileMeta["mime"], size: number): FileMeta => ({
  name,
  mime,
  size,
  entity: "build_report",
  field: "report",
  uploadedBy: null,
  uploadedAt: new Date().toISOString(),
});

export const reportKey = (runId: string): string => `${REPORTS_SCHEMA}/${runId}`;

/** Stores a file of a report (a screenshot, the records); returns its key. */
export async function putReportFile(
  files: FileStorage,
  name: string,
  mime: FileMeta["mime"],
  data: Uint8Array,
): Promise<string> {
  const key = `${REPORTS_SCHEMA}/${randomUUID()}`;
  await files.put(key, data, meta(name, mime, data.byteLength));
  return key;
}

export async function saveBuildReport(files: FileStorage, report: BuildReport): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(report));
  const key = reportKey(report.runId);
  await files.put(key, data, meta(`report-${report.runId}.json`, "application/json", data.byteLength));
  return key;
}

export async function loadBuildReport(files: FileStorage, runId: string): Promise<BuildReport | null> {
  const f = await files.get(reportKey(runId)).catch(() => null);
  return f ? (JSON.parse(new TextDecoder().decode(f.data)) as BuildReport) : null;
}

/** A file of the report `runId` by its key — only keys the report names (no reading of other files). */
export async function reportFile(
  files: FileStorage,
  report: BuildReport,
  key: string,
): Promise<{ data: Uint8Array; mime: string } | null> {
  const known = report.shots.some((s) => s.key === key) || report.records === key;
  if (!known) return null;
  const f = await files.get(key).catch(() => null);
  // The records are JSON lines (stored under the storage's application/json).
  return f ? { data: f.data, mime: key === report.records ? "application/x-ndjson" : f.meta.mime } : null;
}
