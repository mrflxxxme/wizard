// M2-14 acceptance (runtime.yaml#files, security/isolation.yaml#user_files, L3-18): POST /api/files ≤ 10 МБ typed by
// signature (jpeg/png/webp/pdf; SVG/HTML → 415); GET → read permission of the row (rowFilter, hiddenFields) → 302 to a
// short-lived signed link → attachment + CSP sandbox + nosniff; file values are uploads of that field by the writer;
// file fields default to pii basic and their objects are deleted on replace, row delete, retention, consent withdrawal
// and subject erasure; abandoned uploads are swept.
import { randomUUID } from "node:crypto";
import type { AppSpec, Entity } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSession } from "../src/auth/session.js";
import {
  eraseSubject,
  exportSubject,
  FILE_LINK_TTL_MS,
  type LoadedSystem,
  MemoryFileStorage,
  revokeConsent,
  sniffMime,
} from "../src/index.js";
import { forumSpec, type Harness, harness, login, request, seedRow, userIdOf } from "./helpers.js";

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode("<!doctype html><html><body><script>alert(1)</script></body></html>");

/** Forum + speaker_application.slides (file, no pii set → basic); the moderator does not see it. */
function filesSpec(): AppSpec {
  const spec = forumSpec();
  const app = spec.entities.find((e) => e.name === "speaker_application") as Entity;
  app.fields.push({ name: "slides", label: "Презентация", type: "file" });
  const mod = spec.permissions.find((p) => p.role === "moderator" && p.entity === "speaker_application");
  if (mod) mod.hiddenFields = [...(mod.hiddenFields ?? []), "slides"];
  return spec;
}

const storage = new MemoryFileStorage();
let now = new Date();
let h: Harness;
let host = "";
let schema = "";
let speakerA = "";
let speakerB = "";
let organizer = "";
let moderator = "";
let participant = "";
let streamId = "";
let consent: { policyVersion: string; textHash: string };

const sys = async () => (await h.rt.systems.resolve("filesys", "draft")) as LoadedSystem;
const keyOf = (id: string) => `${schema}/${id}`;

async function upload(
  cookie: string | null,
  bytes: Uint8Array,
  o: { name?: string; type?: string; field?: string; entity?: string } = {},
) {
  const form = new FormData();
  form.set(
    "file",
    new File([bytes as Uint8Array<ArrayBuffer>], o.name ?? "slides.pdf", { type: o.type ?? "" }),
  );
  form.set("field", o.field ?? "slides");
  if (o.entity) form.set("entity", o.entity);
  const headers: Record<string, string> = { host, origin: `http://${host}`, "x-wizard-request": "1" };
  if (cookie) headers.cookie = cookie;
  const res = await h.rt.fetch(
    new Request("http://127.0.0.1:4100/api/files", { method: "POST", headers, body: form }),
  );
  return { res, json: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
}

async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const res = await h.rt.fetch(request(method, host, path, { cookie, body }));
  const text = await res.text();
  let json: Record<string, unknown> & { error?: { code: string; details?: { fields?: unknown[] } } } = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json, text };
}

async function application(cookie: string, slides: string | null, extra: Record<string, unknown> = {}) {
  return call("POST", "/api/data/speaker_application", cookie, {
    full_name: "Анна Докладчикова",
    email: `speaker${randomUUID().slice(0, 8)}@example.test`,
    topic: "Доклад",
    abstract: "Тезисы доклада",
    stream: streamId,
    ...(slides !== null ? { slides } : {}),
    ...extra,
    _consent: consent,
  });
}

async function uploaded(cookie: string, bytes = PDF): Promise<string> {
  const r = await upload(cookie, bytes);
  expect(r.res.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json.fileId);
}

/** Detached files are released after the commit (fire-and-forget): wait until the object is gone. */
const gone = (id: string) => expect.poll(() => storage.objects.has(keyOf(id)), { timeout: 3000 }).toBe(false);

beforeAll(async () => {
  h = await harness({}, { files: storage, clock: () => now });
  ({ schema } = await h.system("filesys", filesSpec()));
  host = "filesys--draft.localhost";
  speakerA = await login(h.rt, host, "speaker");
  organizer = await login(h.rt, host, "organizer");
  moderator = await login(h.rt, host, "moderator");
  participant = await login(h.rt, host, "participant");
  streamId = await seedRow(h.sql, schema, filesSpec(), "stream", { name: "Технологии" });
  const spec = (await call("GET", "/_wizard/spec", speakerA)).json as {
    compliance: { policyVersion: string; consentTextHash: string };
  };
  consent = { policyVersion: spec.compliance.policyVersion, textHash: spec.compliance.consentTextHash };
  // Speaker B: a second speaker account with its own session (dev-login reuses dev-speaker).
  const idB = randomUUID();
  await h.sql.unsafe(`insert into "${schema}"."users" (id, role, display_name) values ($1, 'speaker', 'B')`, [
    idB,
  ]);
  speakerB = `${speakerA.split("=")[0]}=${await createSession(await sys(), idB)}`;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe("type by signature (magic bytes)", () => {
  test("jpeg, png, webp, pdf pass; svg, html, xml, js, zip, gif do not", () => {
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 abcd"))).toBe(
      "image/webp",
    );
    expect(sniffMime(PDF)).toBe("application/pdf");
    for (const s of [
      SVG,
      HTML,
      new TextEncoder().encode('<?xml version="1.0"?><a/>'),
      new TextEncoder().encode("alert(document.cookie)"),
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"),
    ])
      expect(sniffMime(s)).toBeNull();
  });
});

describe("POST /api/files", () => {
  test("PDF → 201 {fileId, name, size, mime}; stored under the system schema with the uploader", async () => {
    const r = await upload(speakerA, PDF, { name: "../../Доклад.pdf", type: "text/html" });
    expect(r.res.status).toBe(201);
    expect(r.json).toMatchObject({ name: "Доклад.pdf", size: PDF.byteLength, mime: "application/pdf" });
    const obj = storage.objects.get(keyOf(String(r.json.fileId)));
    expect(obj?.meta).toMatchObject({ entity: "speaker_application", field: "slides" });
    expect(obj?.meta.uploadedBy).toBe(await userIdOf(h.sql, schema, "speaker"));
  });

  test("SVG and HTML with a spoofed name and Content-Type → 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    const before = storage.objects.size;
    for (const [bytes, name, type] of [
      [SVG, "photo.png", "image/png"],
      [HTML, "slides.pdf", "application/pdf"],
    ] as const) {
      const r = await upload(speakerA, bytes, { name, type });
      expect(r.res.status).toBe(415);
      expect(r.json.error).toMatchObject({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Такой тип файла загрузить нельзя",
      });
    }
    expect(storage.objects.size).toBe(before);
  });

  test("> 10 МБ → 413; empty → 422; no multipart → 422; without X-Wizard-Request → 403", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    expect((await upload(speakerA, big)).res.status).toBe(413);
    expect((await upload(speakerA, new Uint8Array())).res.status).toBe(422);
    expect((await call("POST", "/api/files", speakerA, { field: "slides" })).res.status).toBe(422);
    const form = new FormData();
    form.set("file", new File([PDF as Uint8Array<ArrayBuffer>], "a.pdf"));
    form.set("field", "slides");
    const csrf = await h.rt.fetch(
      new Request("http://127.0.0.1:4100/api/files", {
        method: "POST",
        headers: { host, cookie: speakerA },
        body: form,
      }),
    );
    expect(csrf.status).toBe(403);
  });

  test("permission: create/update on the entity, field neither hidden nor readonly", async () => {
    expect((await upload(participant, PDF)).res.status).toBe(403);
    // The moderator may update applications but does not see slides.
    expect((await upload(moderator, PDF)).res.status).toBe(403);
    // Anonymous = the public role visitor, which has no permission on applications.
    expect((await upload(null, PDF)).res.status).toBe(403);
    expect((await upload(speakerA, PDF, { field: "topic" })).res.status).toBe(422);
    expect((await upload(speakerA, PDF, { entity: "stream" })).res.status).toBe(422);
    expect((await upload(organizer, PDF, { entity: "speaker_application" })).res.status).toBe(201);
  });
});

describe("attach, serve, release", () => {
  let fileId = "";
  let appId = "";

  test("file field defaults to pii basic: writing it needs consent", async () => {
    fileId = await uploaded(speakerA);
    const created = await application(speakerA, null);
    expect(created.res.status, created.text).toBe(201);
    appId = String(created.json.item && (created.json.item as { id: string }).id);
    const noConsent = await call("PATCH", `/api/data/speaker_application/${appId}`, speakerA, {
      slides: fileId,
    });
    expect(noConsent.res.status).toBe(422);
    expect(noConsent.json.error?.code).toBe("CONSENT_REQUIRED");
    const ok = await call("PATCH", `/api/data/speaker_application/${appId}`, speakerA, {
      slides: fileId,
      _consent: consent,
    });
    expect(ok.res.status, ok.text).toBe(200);
    expect((ok.json.item as { slides: string }).slides).toBe(fileId);
  });

  test("GET → 302 to a signed link; the link serves an attachment under CSP sandbox and nosniff", async () => {
    const r = await call("GET", `/api/files/${fileId}`, speakerA);
    expect(r.res.status).toBe(302);
    const location = r.res.headers.get("location") ?? "";
    expect(location).toMatch(new RegExp(`^/api/files/${fileId}/content\\?t=[A-Za-z0-9_-]+$`));
    expect(r.res.headers.get("cache-control")).toContain("no-store");
    const dl = await h.rt.fetch(request("GET", host, location, { cookie: speakerA }));
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="slides\.pdf"/);
    expect(dl.headers.get("content-security-policy")).toMatch(/^sandbox(;|$)/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    const info = await call("GET", `/api/files/${fileId}/info`, speakerA);
    expect(info.json).toEqual({ fileId, name: "slides.pdf", size: PDF.byteLength, mime: "application/pdf" });
    // The organizer reads every application.
    expect((await call("GET", `/api/files/${fileId}`, organizer)).res.status).toBe(302);
  });

  test("another row's file → 404: rowFilter (speaker B), hidden field (moderator), no permission, unknown id", async () => {
    for (const cookie of [speakerB, moderator, participant]) {
      expect((await call("GET", `/api/files/${fileId}`, cookie)).res.status).toBe(404);
      expect((await call("GET", `/api/files/${fileId}/info`, cookie)).res.status).toBe(404);
    }
    expect((await call("GET", `/api/files/${randomUUID()}`, organizer)).res.status).toBe(404);
    expect((await call("GET", "/api/files/../../etc/passwd", organizer)).res.status).toBe(404);
  });

  test("the signed link: bound to the user, expires (TTL ≤ 15 min), tamper-proof", async () => {
    const location = (await call("GET", `/api/files/${fileId}`, speakerA)).res.headers.get("location") ?? "";
    expect(FILE_LINK_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
    expect((await h.rt.fetch(request("GET", host, location, { cookie: speakerB }))).status).toBe(404);
    expect((await h.rt.fetch(request("GET", host, `${location}x`, { cookie: speakerA }))).status).toBe(404);
    const other = await uploaded(speakerA);
    const foreign = location.replace(fileId, other);
    expect((await h.rt.fetch(request("GET", host, foreign, { cookie: speakerA }))).status).toBe(404);
    const saved = now;
    now = new Date(saved.getTime() + FILE_LINK_TTL_MS + 1000);
    try {
      expect((await h.rt.fetch(request("GET", host, location, { cookie: speakerA }))).status).toBe(404);
    } finally {
      now = saved;
    }
  });

  test("a value must be an upload of this field by the writer and held by no other row", async () => {
    const fieldErr = async (r: Awaited<ReturnType<typeof call>>) => {
      expect(r.res.status, r.text).toBe(422);
      expect(r.json.error?.details?.fields).toEqual([
        expect.objectContaining({ field: "slides", code: "FILE_NOT_FOUND" }),
      ]);
    };
    // Speaker B attaches A's upload (pending) and A's attached file; random and malformed ids.
    const pendingA = await uploaded(speakerA);
    await fieldErr(await application(speakerB, pendingA));
    await fieldErr(await application(speakerB, fileId));
    await fieldErr(await application(speakerB, randomUUID()));
    await fieldErr(await application(speakerB, "seed/photo.png"));
    // A attaches the file of her first application to a second one.
    await fieldErr(await application(speakerA, fileId));
    // An upload for another field of the system cannot be attached here.
    const s = await sys();
    const stray = randomUUID();
    await storage.put(keyOf(stray), PDF, {
      name: "x.pdf",
      mime: "application/pdf",
      size: PDF.byteLength,
      entity: "session",
      field: "slides",
      uploadedBy: await userIdOf(h.sql, schema, "speaker"),
      uploadedAt: now.toISOString(),
    });
    await fieldErr(await application(speakerA, stray));
    expect(s.files).not.toBeNull();
    expect((await application(speakerB, await uploaded(speakerB))).res.status).toBe(201);
  });

  test("replace → the old object is deleted; row delete → its file is deleted", async () => {
    const next = await uploaded(speakerA);
    const r = await call("PATCH", `/api/data/speaker_application/${appId}`, speakerA, {
      slides: next,
      _consent: consent,
    });
    expect(r.res.status, r.text).toBe(200);
    await gone(fileId);
    expect(storage.objects.has(keyOf(next))).toBe(true);
    // A failed write releases nothing.
    const bad = await call("PATCH", `/api/data/speaker_application/${appId}`, speakerA, {
      slides: randomUUID(),
      _consent: consent,
    });
    expect(bad.res.status).toBe(422);
    expect(storage.objects.has(keyOf(next))).toBe(true);
    expect((await call("DELETE", `/api/data/speaker_application/${appId}`, organizer)).res.status).toBe(204);
    await gone(next);
  });
});

describe("pii: retention, consent withdrawal, subject requests, sweep", () => {
  test("retention anonymize (180 days) clears the field and deletes the file", async () => {
    const id = await uploaded(speakerA);
    const r = await application(speakerA, id);
    expect(r.res.status, r.text).toBe(201);
    const rowId = (r.json.item as { id: string }).id;
    await h.sql.unsafe(
      `update "${schema}"."speaker_application" set created_at = now() - interval '200 days' where id = $1`,
      [rowId],
    );
    const report = await h.rt.runJobs({ slug: "filesys", env: "draft", now: new Date() });
    expect(report.retention).toContainEqual(expect.objectContaining({ entity: "speaker_application" }));
    const [row] = await h.sql.unsafe(`select slides from "${schema}"."speaker_application" where id = $1`, [
      rowId,
    ]);
    expect(row?.slides).toBeNull();
    expect(storage.objects.has(keyOf(id))).toBe(false);
  });

  test("consent withdrawal anonymizes the owner's rows and deletes their files", async () => {
    const id = await uploaded(speakerB);
    expect((await application(speakerB, id)).res.status).toBe(201);
    const [b] = await h.sql.unsafe(`select id from "${schema}"."users" where display_name = 'B'`);
    const res = await revokeConsent(await sys(), String(b?.id));
    expect(res.entities).toContainEqual(expect.objectContaining({ entity: "speaker_application" }));
    expect(storage.objects.has(keyOf(id))).toBe(false);
  });

  test("subject export names the file; subject erasure deletes it", async () => {
    const id = await uploaded(speakerA);
    const email = "subject-files@example.test";
    expect((await application(speakerA, id, { email })).res.status).toBe(201);
    const s = await sys();
    const adminId = await userIdOf(h.sql, schema, "organizer");
    const out = await exportSubject(s, { email, phone: null }, adminId, new Date());
    const rows = out.entities.find((x) => x.entity === "speaker_application")?.rows ?? [];
    expect(rows.map((r) => r.slides)).toContain("slides.pdf");
    const erased = await eraseSubject(s, { email, phone: null }, adminId);
    expect(JSON.stringify(erased)).not.toContain(id);
    expect(storage.objects.has(keyOf(id))).toBe(false);
  });

  test("uploads never attached are swept after 24 h by the retention pass; attached ones stay", async () => {
    const s = await sys();
    const pending = await uploaded(speakerA);
    const kept = await uploaded(speakerA);
    expect((await application(speakerA, kept)).res.status).toBe(201);
    expect(await s.files?.sweep(new Date(now.getTime() + 3600_000))).toBe(0);
    expect(storage.objects.has(keyOf(pending))).toBe(true);
    await h.rt.runJobs({ slug: "filesys", env: "draft", now: new Date(now.getTime() + 25 * 3600_000) });
    expect(storage.objects.has(keyOf(pending))).toBe(false);
    expect(storage.objects.has(keyOf(kept))).toBe(true);
  });
});
