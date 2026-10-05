// /api/files (runtime.yaml#files, security/isolation.yaml#user_files, L3-18): upload ≤ 10 МБ typed by signature,
// GET → read permission of the row holding the file → 302 to a short-lived link signed by the runtime, which serves
// the bytes as an attachment under CSP sandbox and nosniff. Image fields (runtime.yaml#files.image, M2-47): the upload is
// turned into WebP variants 480/960/1600 without EXIF (media/), served inline from /api/files/:fileId/img/:slot with a
// long cache; reading follows the same row permission.
import { randomUUID } from "node:crypto";
import { type AppSpec, type Entity, type Field, isFileFieldType } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { compilePolicy } from "@wizard/sdk/host";
import { Hono } from "hono";
import type { AuthKeys } from "../auth/keys.js";
import type { Subject } from "../data/access.js";
import { fieldsError } from "../data/validate.js";
import { attachmentDisposition, MAX_FILE_BYTES, safeFileName, sniffMime } from "../files/sniff.js";
import type { FileMeta } from "../files/storage.js";
import { FILE_ID_RE, type SystemFiles } from "../files/system-files.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { errorResponse } from "../http/errors.js";
import { sessionOf, subjectOf } from "../http/subject.js";
import { IMAGE_WIDTHS, isImageMime } from "../media/header.js";
import { ImageError, imageProcessor } from "../media/processor.js";
import type { LoadedSystem } from "../system.js";

/** Lifetime of a download link (runtime.yaml#files.serve: TTL ≤ 15 min). */
export const FILE_LINK_TTL_MS = 5 * 60_000;
/** Uploads per user (or client network of the public role) per hour in one system. */
export const UPLOADS_PER_HOUR = 60;
/** Multipart overhead allowed above the file limit. */
const FORM_OVERHEAD = 256 * 1024;

const tooLarge = () => new WizardError("PAYLOAD_TOO_LARGE", { message: "Файл больше 10 МБ" });
const notFound = () => new WizardError("NOT_FOUND", { message: "Файл не найден" });

/** ImageError → the runtime error of POST /api/files (413 / 422 / 429). */
function imageFailure(e: ImageError): WizardError {
  if (e.code === "TOO_LARGE")
    return new WizardError("PAYLOAD_TOO_LARGE", {
      message: "Картинка слишком большая: до 8000 точек по стороне и до 40 мегапикселей",
    });
  if (e.code === "BUSY")
    return new WizardError("RATE_LIMITED", {
      message: "Сейчас обрабатывается много картинок — повторите через минуту",
    });
  return new WizardError("VALIDATION_FAILED", {
    message: "Не удалось обработать картинку — попробуйте другой файл",
  });
}

function filesOf(c: RuntimeContext): SystemFiles {
  const files = c.get("system").files;
  if (!files) throw new WizardError("NOT_FOUND", { message: "Файлы в этой системе недоступны" });
  return files;
}

/** Body up to `cap` bytes; more → 413 (also without Content-Length). */
async function readCapped(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(req.headers.get("content-length") ?? "0") > cap) throw tooLarge();
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.byteLength;
  }
  return out;
}

/**
 * Entity and file or image field the subject may upload into: create or update on the entity, field neither hidden nor
 * readonly. Image fields take uploads from signed-in roles only (the public role does not upload pictures, M2-47).
 */
export function uploadTarget(
  spec: AppSpec,
  subject: Subject,
  field: string,
  entity?: string,
): { entity: Entity; field: Field } {
  const invalid = (message: string) =>
    fieldsError("VALIDATION_FAILED", [{ field: entity ? "entity" : "field", code: "INVALID", message }]);
  const candidates = spec.entities
    .filter((e) => entity === undefined || e.name === entity)
    .flatMap((e) => {
      const f = e.fields.find((x) => x.name === field && isFileFieldType(x.type));
      return f ? [{ entity: e, field: f }] : [];
    });
  if (candidates.length === 0) throw invalid("Такого поля для файла нет");
  const allowed = candidates.filter(({ entity: e, field: f }) => {
    const p = compilePolicy(spec, e.name, { id: subject.id, role: subject.role, record: subject.record });
    if (f.type === "image" && publicSubject(spec, subject)) return false;
    return (p.allows("create") || p.allows("update")) && !p.hidden.has(f.name) && !p.readonly.has(f.name);
  });
  if (allowed.length === 0) throw new WizardError("FORBIDDEN");
  if (allowed.length > 1) throw invalid("Укажите раздел (entity): поле с таким именем есть в нескольких");
  return allowed[0] as { entity: Entity; field: Field };
}

/** The public role (no account): image uploads are closed to it. */
function publicSubject(spec: AppSpec, subject: Subject): boolean {
  return subject.id === null || spec.roles.find((r) => r.name === subject.role)?.access === "public";
}

/** Metadata of a file the subject may read: a row with this value is visible and the field is not hidden. */
export async function readableFile(
  sys: LoadedSystem,
  subject: Subject,
  fileId: string,
): Promise<FileMeta | null> {
  if (!sys.files || !FILE_ID_RE.test(fileId)) return null;
  const meta = await sys.files.head(fileId);
  if (!meta) return null;
  const e = sys.spec.entities.find((x) => x.name === meta.entity);
  if (!e?.fields.some((f) => f.name === meta.field && isFileFieldType(f.type))) return null;
  try {
    const doc = await sys.data.transaction("read", subject, (d) =>
      d.data.getBy(meta.entity, meta.field, fileId),
    );
    return doc && doc[meta.field] === fileId ? meta : null;
  } catch (err) {
    // No read permission, a hidden field or a row outside rowFilter: the file does not exist for this subject.
    if (err instanceof WizardError && err.code !== "INTERNAL" && err.code !== "TIMEOUT") return null;
    throw err;
  }
}

interface LinkClaims {
  f: string;
  u: string | null;
  x: number;
}

const linkAad = (sys: LoadedSystem) => `wz-file:${sys.schema}`;

class UploadLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Seconds to wait, or 0 when the upload may go. */
  take(key: string, now: number): number {
    const from = now - 3600_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (list.length >= UPLOADS_PER_HOUR) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil(((list[0] as number) + 3600_000 - now) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.delete(this.hits.keys().next().value as string);
    return 0;
  }
}

export function filesRoutes(keys: AuthKeys): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const limiter = new UploadLimiter();

  app.post("/", async (c) => {
    const sys = c.get("system");
    const files = filesOf(c);
    const subject = await subjectOf(c);
    const ct = c.req.header("content-type") ?? "";
    if (!/^multipart\/form-data/i.test(ct))
      throw new WizardError("VALIDATION_FAILED", { message: "Ожидается multipart/form-data с полем file" });
    const body = await readCapped(c.req.raw, MAX_FILE_BYTES + FORM_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": ct } }).formData();
    } catch {
      throw new WizardError("VALIDATION_FAILED", { message: "Не удалось прочитать форму" });
    }
    const file = form.get("file");
    const field = form.get("field");
    const entity = form.get("entity");
    if (!(file instanceof Blob) || typeof field !== "string" || !field)
      throw new WizardError("VALIDATION_FAILED", { message: "Нужны поля формы file и field" });
    const target = uploadTarget(
      sys.spec,
      subject,
      field,
      typeof entity === "string" && entity ? entity : undefined,
    );
    if (file.size > MAX_FILE_BYTES) throw tooLarge();
    if (file.size === 0) throw new WizardError("VALIDATION_FAILED", { message: "Файл пустой" });
    const data = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(data);
    if (!mime) throw new WizardError("UNSUPPORTED_MEDIA_TYPE");
    const services = c.get("services");
    const who = subject.id ?? services.ipHmac?.(c.req.raw)?.toString("hex") ?? "public";
    const wait = limiter.take(`${sys.schema}:${who}`, services.clock().getTime());
    if (wait > 0) {
      const res = errorResponse(new WizardError("RATE_LIMITED"), c.get("requestId"));
      res.headers.set("Retry-After", String(wait));
      return res;
    }
    const fileId = randomUUID();
    if (target.field.type === "image") {
      if (!isImageMime(mime))
        throw new WizardError("UNSUPPORTED_MEDIA_TYPE", { message: "Нужна картинка JPEG, PNG или WebP" });
      let img: Awaited<ReturnType<ReturnType<typeof imageProcessor>["process"]>>;
      try {
        img = await imageProcessor().process(data, mime);
      } catch (e) {
        if (e instanceof ImageError) throw imageFailure(e);
        throw e;
      }
      const [largest, ...smaller] = img.variants;
      if (!largest) throw imageFailure(new ImageError("UNREADABLE"));
      const base = safeFileName(file instanceof File ? file.name : "", mime).replace(
        /\.[A-Za-z0-9]{1,5}$/,
        "",
      );
      const common = {
        mime: "image/webp" as const,
        entity: target.entity.name,
        field: target.field.name,
        uploadedBy: subject.id,
        uploadedAt: services.clock().toISOString(),
      };
      for (const v of smaller)
        await files.storage.put(files.variantKey(fileId, v.slot), v.data, {
          ...common,
          name: `${base}-${v.width}.webp`,
          size: v.data.byteLength,
        });
      const meta: FileMeta = {
        ...common,
        name: `${base}.webp`,
        size: largest.data.byteLength,
        image: { width: img.width, height: img.height, variants: smaller.map((v) => v.slot) },
      };
      await files.storage.put(files.key(fileId), largest.data, meta);
      return c.json(
        { fileId, name: meta.name, size: meta.size, mime: meta.mime, width: img.width, height: img.height },
        201,
      );
    }
    const meta: FileMeta = {
      name: safeFileName(file instanceof File ? file.name : "", mime),
      mime,
      size: data.byteLength,
      entity: target.entity.name,
      field: target.field.name,
      uploadedBy: subject.id,
      uploadedAt: services.clock().toISOString(),
    };
    await files.storage.put(files.key(fileId), data, meta);
    return c.json({ fileId, name: meta.name, size: meta.size, mime: meta.mime }, 201);
  });

  // Image variant, inline (runtime.yaml#files.image.serve): the row permission of every read, short revalidated cache.
  app.get("/:fileId/img/:slot", async (c) => {
    const sys = c.get("system");
    const files = filesOf(c);
    const id = c.req.param("fileId");
    const slot = Number(c.req.param("slot"));
    if (!IMAGE_WIDTHS.includes(slot as never)) throw notFound();
    const subject = await subjectOf(c);
    const meta = await readableFile(sys, subject, id);
    if (!meta?.image) throw notFound();
    const key = meta.image.variants.includes(slot) ? files.variantKey(id, slot) : files.key(id);
    const etag = `"${id}-${meta.image.variants.includes(slot) ? slot : "max"}"`;
    const headers: Record<string, string> = {
      "Content-Type": "image/webp",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      // The bytes of a fileId never change, but read access to its row can be taken away: a short cache that the
      // browser revalidates (ETag → 304 only after the row check above). Shared caches only for the public role.
      "Cache-Control": `${subject.id === null ? "public" : "private"}, max-age=300, must-revalidate`,
      ETag: etag,
      "Referrer-Policy": "no-referrer",
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    const obj = await files.storage.get(key);
    if (obj?.meta.mime !== "image/webp") throw notFound();
    return new Response(obj.data as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { ...headers, "Content-Length": String(obj.data.byteLength) },
    });
  });

  app.get("/:fileId/info", async (c) => {
    const id = c.req.param("fileId");
    const meta = await readableFile(c.get("system"), await subjectOf(c), id);
    if (!meta) throw notFound();
    const dims = meta.image ? { width: meta.image.width, height: meta.image.height } : {};
    return c.json({ fileId: id, name: meta.name, size: meta.size, mime: meta.mime, ...dims }, 200, {
      "Cache-Control": "private, no-store",
    });
  });

  app.get("/:fileId/content", async (c) => {
    const sys = c.get("system");
    const files = filesOf(c);
    const id = c.req.param("fileId");
    const claims = keys.unseal<LinkClaims>(c.req.query("t") ?? "", linkAad(sys));
    const { subject } = await sessionOf(c);
    if (
      !claims ||
      claims.f !== id ||
      claims.x < c.get("services").clock().getTime() ||
      claims.u !== (subject.id ?? null)
    )
      throw new WizardError("NOT_FOUND", { message: "Ссылка на файл устарела — откройте файл снова" });
    const obj = await files.storage.get(files.key(id));
    if (!obj) throw notFound();
    return new Response(obj.data as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": obj.meta.mime,
        "Content-Length": String(obj.data.byteLength),
        "Content-Disposition": attachmentDisposition(obj.meta.name),
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });

  app.get("/:fileId", async (c) => {
    const sys = c.get("system");
    filesOf(c);
    const id = c.req.param("fileId");
    const subject = await subjectOf(c);
    if (!(await readableFile(sys, subject, id))) throw notFound();
    const claims: LinkClaims = {
      f: id,
      u: subject.id ?? null,
      x: c.get("services").clock().getTime() + FILE_LINK_TTL_MS,
    };
    const t = keys.seal(claims, linkAad(sys));
    return c.body(null, 302, {
      Location: `/api/files/${id}/content?t=${t}`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
  });

  return app;
}
