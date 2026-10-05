// Files of one loaded system: keys under its schema, the attach guard of DataAccess writes, deletion of files their rows
// no longer reference (replace, delete, retention, anonymize, consent withdrawal, subject erasure; runtime.yaml#files
// .pii_and_retention) and the sweep of abandoned uploads.
import { type AppSpec, isFileFieldType, quoteIdent } from "@wizard/appspec";
import { type DataAccess, SYSTEM_SUBJECT } from "../data/access.js";
import type { FileMeta, FileStorage } from "./storage.js";

/** Uploads not attached to any row are deleted after this long (sweep in the retention pass). */
export const ABANDONED_UPLOAD_MS = 24 * 3600_000;
export const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FILE_NOT_FOUND_RU = "Файл не найден — загрузите его снова";

/** DataAccess hook: file field values are fileIds of uploads for that very entity.field (pg.ts). */
export interface FileFieldGuard {
  /** null when `fileId` may be attached by the writer (the uploader, or system context); else a Russian message. */
  check(input: {
    entity: string;
    field: string;
    fileId: string;
    uploader: string | null;
    system: boolean;
  }): Promise<string | null>;
  /** After a commit: file ids a write detached (replaced or cleared values, deleted rows). */
  released(ids: readonly string[]): void;
}

export class SystemFiles {
  private data: DataAccess | null = null;

  constructor(
    readonly storage: FileStorage,
    readonly schema: string,
    private readonly spec: AppSpec,
    private readonly log?: (line: Record<string, unknown>) => void,
  ) {}

  /** DataAccess of the same system (reference checks run as its system role). */
  bind(data: DataAccess): void {
    this.data = data;
  }

  key(fileId: string): string {
    return `${this.schema}/${fileId}`;
  }

  /** Key of a smaller variant of an image (slot 480 or 960; the largest variant is key(fileId) itself). */
  variantKey(fileId: string, slot: number): string {
    return `${this.key(fileId)}.w${slot}`;
  }

  /** Deletes an object and its image variants. */
  private async remove(fileId: string): Promise<void> {
    const meta = await this.storage.head(this.key(fileId)).catch(() => null);
    for (const slot of meta?.image?.variants ?? []) await this.storage.delete(this.variantKey(fileId, slot));
    await this.storage.delete(this.key(fileId));
  }

  head(fileId: string): Promise<FileMeta | null> {
    return FILE_ID_RE.test(fileId) ? this.storage.head(this.key(fileId)) : Promise.resolve(null);
  }

  /** (entity, field) pairs of type file. */
  fileFields(): { entity: string; field: string }[] {
    return this.spec.entities.flatMap((e) =>
      e.fields.filter((f) => isFileFieldType(f.type)).map((f) => ({ entity: e.name, field: f.name })),
    );
  }

  guard(): FileFieldGuard {
    return {
      check: async ({ entity, field, fileId, uploader, system }) => {
        const meta = await this.head(fileId);
        if (!meta || meta.entity !== entity || meta.field !== field) return FILE_NOT_FOUND_RU;
        if (!system && meta.uploadedBy !== uploader) return FILE_NOT_FOUND_RU;
        return null;
      },
      released: (ids) => {
        if (ids.length === 0) return;
        this.release(ids).catch((err: unknown) => this.fail("files_release_failed", err));
      },
    };
  }

  private fail(msg: string, err: unknown): void {
    this.log?.({
      ts: new Date().toISOString(),
      level: "error",
      msg,
      schema: this.schema,
      reason: err instanceof Error ? err.name : "unknown",
    });
  }

  /** Ids among `ids` some row of the system still holds (system DB role, L3-20). */
  async referenced(ids: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const fields = this.fileFields();
    const valid = [...new Set(ids)].filter((id) => FILE_ID_RE.test(id));
    if (valid.length === 0 || fields.length === 0) return out;
    if (!this.data) throw new Error("SystemFiles is not bound to its DataAccess");
    const S = quoteIdent(this.schema);
    const parts = fields.map(
      ({ entity, field }) =>
        `select ${quoteIdent(field)}::text as v from ${S}.${quoteIdent(entity)} where ${quoteIdent(field)}::text = any($1::text[])`,
    );
    const rows = await this.data.transaction("read", SYSTEM_SUBJECT, (d) =>
      d.sql.unsafe(parts.join(" union "), [valid as never]),
    );
    for (const r of rows) out.add(String(r.v));
    return out;
  }

  /** Deletes the objects of `ids` no row references any more; returns how many were deleted. */
  async release(ids: readonly string[]): Promise<number> {
    const valid = [...new Set(ids)].filter((id) => FILE_ID_RE.test(id));
    if (valid.length === 0) return 0;
    const refs = await this.referenced(valid);
    let n = 0;
    for (const id of valid) {
      if (refs.has(id)) continue;
      await this.remove(id);
      n++;
    }
    return n;
  }

  /**
   * Objects of the schema no row references and older than `graceMs` (abandoned uploads, files whose release failed)
   * are deleted. Runs at the end of the retention pass.
   */
  async sweep(now: Date, graceMs = ABANDONED_UPLOAD_MS): Promise<number> {
    const keys = await this.storage.list(`${this.schema}/`);
    if (keys.length === 0) return 0;
    // Image variants (<id>.w<slot>) live and die with their object: grouped by the fileId.
    const groups = new Map<string, string[]>();
    for (const k of keys) {
      const id = k.slice(this.schema.length + 1).split(".")[0] as string;
      groups.set(id, [...(groups.get(id) ?? []), k]);
    }
    const refs = await this.referenced([...groups.keys()]);
    let n = 0;
    for (const [id, group] of groups) {
      if (refs.has(id)) continue;
      const meta = await this.storage.head(
        group.includes(this.key(id)) ? this.key(id) : (group[0] as string),
      );
      const at = Date.parse(meta?.uploadedAt ?? "");
      if (meta && !Number.isNaN(at) && now.getTime() - at < graceMs) continue;
      for (const k of group) await this.storage.delete(k);
      n++;
    }
    return n;
  }
}
