#!/usr/bin/env node
// V4-02 (product.yaml#decisions.D79_v4 (11)): moves done tasks of finished milestones from specs/backlog.yaml to
// specs/backlog-archive.yaml, so agents do not read hundreds of closed tasks. Text-level: task blocks move verbatim
// with their section comment; validate.mjs, slice.mjs and tools/progress read both files.
// Run: node tools/specs/archive.mjs [--keep=V4,…] [--root=<repo>]  (milestones in --keep stay; default: V4)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ARCHIVE_HEADER = `# Архив backlog.yaml: сделанные задачи прошлых вех (V4-02, D79 (11)), перенесены дословно скриптом
# tools/specs/archive.mjs. Только для справки и зависимостей: validate.mjs, slice.mjs и tools/progress читают оба файла.
# Новые задачи и правки статусов — только в specs/backlog.yaml.
tasks:
`;

/** Splits the body of a backlog (after "tasks:") into section comments and task blocks, in order. */
export function splitBacklog(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "tasks:");
  if (start < 0) throw new Error("нет строки tasks:");
  const head = lines.slice(0, start + 1);
  const items = [];
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  # ")) {
      cur = { kind: "section", lines: [line] };
      items.push(cur);
    } else if (line.startsWith("  - id: ")) {
      cur = { kind: "task", id: line.slice(8).trim(), lines: [line] };
      items.push(cur);
    } else if (cur) cur.lines.push(line);
    else head.push(line);
  }
  for (const it of items) {
    if (it.kind !== "task") continue;
    const body = it.lines.join("\n");
    it.status = /^ {4}status: (\S+)/m.exec(body)?.[1];
    it.milestone = /^ {4}milestone: (\S+)/m.exec(body)?.[1];
  }
  return { head, items };
}

/** New texts of the backlog and the archive; done tasks outside `keep` milestones move to the archive. */
export function archiveDone(backlogText, archiveText, keep = new Set(["V4"])) {
  const { head, items } = splitBacklog(backlogText);
  const stay = [];
  const moved = [];
  let section = null;
  let sectionMoved = false;
  let sectionStays = null;
  for (const it of items) {
    if (it.kind === "section") {
      section = it;
      sectionMoved = false;
      sectionStays = { pending: it };
      continue;
    }
    const goes = it.status === "done" && !keep.has(it.milestone);
    if (goes) {
      if (section && !sectionMoved) moved.push(...section.lines), (sectionMoved = true);
      moved.push(...it.lines);
    } else {
      if (sectionStays?.pending) stay.push(...sectionStays.pending.lines), (sectionStays.pending = null);
      stay.push(...it.lines);
    }
  }
  const trim = (ls) => ls.join("\n").replace(/\n+$/, "");
  const backlog = `${trim([...head, ...stay])}\n`;
  const base = archiveText && archiveText.includes("\ntasks:") ? archiveText.replace(/\n+$/, "") : ARCHIVE_HEADER.trimEnd();
  const archive = moved.length ? `${base}\n${trim(moved)}\n` : `${base}\n`;
  return { backlog, archive, moved: items.filter((i) => i.kind === "task" && moved.includes(i.lines[0])).map((i) => i.id) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const root = resolve(arg("root") ?? join(import.meta.dirname, "../.."));
  const keep = new Set((arg("keep") ?? "V4").split(",").filter(Boolean));
  const bp = join(root, "specs/backlog.yaml");
  const ap = join(root, "specs/backlog-archive.yaml");
  const r = archiveDone(readFileSync(bp, "utf8"), existsSync(ap) ? readFileSync(ap, "utf8") : "", keep);
  writeFileSync(bp, r.backlog);
  writeFileSync(ap, r.archive);
  console.log(`archive: перенесено задач ${r.moved.length}`);
}
