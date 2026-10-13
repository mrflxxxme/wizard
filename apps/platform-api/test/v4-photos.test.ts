// V4-16: photos of a system. The choice for a photo slot is the owner's photos first, then the semantic library (V4-10
// public search) by the slot's meaning — the brief when no words — or by the owner's words; an owner upload is
// re-encoded (WebP, no EXIF) into the system's own library under a random id, offered first next time, never written to
// the shared library index; its 480 px preview is served to the panel; too large or not an image is refused in words.
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Candidate } from "@wizard/agents/stock";
import { MemoryFileStorage, readLibraryIndex } from "@wizard/runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, startApi, type TestApi } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId: string;
const files = new MemoryFileStorage();
const queries: string[] = [];

const entry = (i: number) =>
  ({
    entry: {
      provider: "pexels",
      id: String(i),
      file: randomUUID(),
      author: `Автор ${i}`,
      pageUrl: `https://www.pexels.com/photo/${i}/`,
      width: 1600,
      height: 1067,
      color: "#888888",
      luma: 0.5,
      query: "dentist",
      niche: "dental",
    },
    score: 1 - i / 100,
  }) as unknown as Candidate;

/** A real PNG (RGB gradient) of w×h. */
function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = 128;
    }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

beforeAll(async () => {
  tdb = await createTestDb("v4photos");
  api = await startApi(tdb.url, {
    photoFiles: files,
    photoSearch: {
      async search(text, o) {
        queries.push(text);
        return Array.from({ length: o.limit ?? 20 }, (_, i) => entry(i + 1));
      },
    },
  });
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `v4p-${key}`,
      schema_key: key,
      name: "Клиника «Фото»",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  systemId = row.id;
  await saveBriefVersion(api.deps.db, {
    systemId,
    brief: {
      goals: [
        { id: "g1", text: "Пациенты записываются к стоматологу онлайн", success: "50 записей в месяц" },
      ],
      audience: "Семьи с детьми в районе",
    },
    author: "agent",
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

test("the choice for a slot: the library by the brief's meaning, or by the owner's words; at most 20", async () => {
  const byBrief = await api.req("GET", `/systems/${systemId}/photos`);
  expect(byBrief.status).toBe(200);
  expect(byBrief.body.query).toContain("Пациенты записываются к стоматологу онлайн");
  expect(byBrief.body.photos).toHaveLength(20);
  expect(byBrief.body.photos[0]).toMatchObject({ source: "library", author: "Автор 1", provider: "pexels" });
  expect(byBrief.body.photos[0].thumb).toBe(
    `/api/v1/systems/${systemId}/photos/${byBrief.body.photos[0].id}/thumb`,
  );
  const byWords = await api.req("GET", `/systems/${systemId}/photos?q=${encodeURIComponent("улыбка врача")}`);
  expect(byWords.body.query).toBe("улыбка врача");
  expect(queries.at(-1)).toBe("улыбка врача");
  expect((await api.req("GET", `/systems/${systemId}/photos?ref=bad`)).status).toBe(400);
});

test("an owner photo: re-encoded into the system's own library, offered first, previewed, never in the shared index", async () => {
  const form = new FormData();
  form.set("file", new Blob([png(64, 48)], { type: "image/png" }), "photo.png");
  const up = await api.req("POST", `/systems/${systemId}/photos`, { body: form });
  expect(up.status).toBe(201);
  const id: string = up.body.photo.id;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(up.body.photo).toMatchObject({ source: "owner", width: 64, height: 48 });
  // Stored as WebP (the pipeline drops EXIF and the original bytes).
  const head = await files.head(`wz_photos/${id}`);
  expect(head?.mime).toBe("image/webp");
  const list = await api.req("GET", `/systems/${systemId}/photos`);
  expect(list.body.photos[0]).toMatchObject({ id, source: "owner" });
  expect(list.body.photos).toHaveLength(20);
  const thumb = await api.req("GET", `/systems/${systemId}/photos/${id}/thumb`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("content-type")).toBe("image/webp");
  const shared = await readLibraryIndex(files).catch(() => null);
  expect(JSON.stringify(shared ?? {})).not.toContain(id);
});

test("refused in words: not an image, more than 15 MB", async () => {
  const text = new FormData();
  text.set("file", new Blob([new TextEncoder().encode("not a photo")], { type: "image/png" }), "x.png");
  const bad = await api.req("POST", `/systems/${systemId}/photos`, { body: text });
  expect(bad.status).toBe(415);
  expect(bad.body.message_ru).toContain("JPEG или PNG");
  const big = new FormData();
  big.set("file", new Blob([new Uint8Array(16 * 1024 * 1024)], { type: "image/jpeg" }), "big.jpg");
  const huge = await api.req("POST", `/systems/${systemId}/photos`, { body: big });
  expect(huge.status).toBe(413);
});
