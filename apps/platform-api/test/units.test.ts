// Unit tests: system stage table (workflows.yaml#system_stage.test), logo sanitising, slugs, blob integrity.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { ApiError } from "../src/errors.js";
import { answerLine } from "../src/routes/systems.js";
import { processLogo, sniff } from "../src/services/logo.js";
import { isSafePath } from "../src/services/revisions.js";
import { isAutoName, makeSlug, nameFromPrompt, RESERVED_SLUGS, SLUG_RE } from "../src/services/slug.js";
import { assertTransition, IllegalTransition, STAGES } from "../src/services/stage.js";
import { BlobStore, IntegrityError, sha256 } from "../src/storage/blobs.js";
import { loadYaml } from "./helpers.js";

describe("answers message (FU-4)", () => {
  test("question then answer, never «?:»", () => {
    expect(answerLine("Как проверять билеты на входе?", "QR-сканер")).toBe(
      "Как проверять билеты на входе? — QR-сканер",
    );
    expect(answerLine("Способ входа:", " По почте ")).toBe("Способ входа — По почте");
    expect(answerLine("q1", "Да")).toBe("q1 — Да");
  });
});

describe("system stage transitions", () => {
  const wf = loadYaml("specs/platform/workflows.yaml") as {
    system_stage: { states: string[]; transitions: { from: string; to: string }[] };
  };
  const listed = new Set(wf.system_stage.transitions.map((t) => `${t.from}>${t.to}`));
  // Documented addition (impl-notes M0-15): fix after a build that left no preview.
  listed.add("failed>building");

  test("states match the spec", () => {
    expect([...STAGES]).toEqual(wf.system_stage.states);
  });

  for (const from of STAGES) {
    for (const to of STAGES) {
      const key = `${from}>${to}`;
      test(`${key} ${listed.has(key) ? "allowed" : "throws IllegalTransition"}`, () => {
        if (listed.has(key)) expect(assertTransition(from, to)).toBe(to);
        else expect(() => assertTransition(from, to)).toThrow(IllegalTransition);
      });
    }
  }
});

function pngWithText(w: number, h: number): Buffer {
  const img = new PNG({ width: w, height: h });
  img.data.fill(128);
  const buf = PNG.sync.write(img);
  // Insert a tEXt chunk (metadata) right after IHDR.
  const text = Buffer.from("Author\0Secret Person");
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write("tEXt", 4, "latin1");
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)), 8 + text.length);
  return Buffer.concat([buf.subarray(0, 33), chunk, buf.subarray(33)]);
}

function webp(w: number, h: number, extra: string[] = []): Buffer {
  const vp8l = Buffer.alloc(5);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  const chunk = (fourcc: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    chunk("VP8L", vp8l),
    ...extra.map((f) => chunk(f, Buffer.from("GPS 55.75,37.61"))),
  ]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, body]);
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
  return "ok";
};

describe("logo", () => {
  test("PNG is re-encoded ≤ 512×512 without metadata", () => {
    const src = pngWithText(1024, 256);
    expect(src.includes(Buffer.from("Secret Person"))).toBe(true);
    const out = processLogo(src);
    expect(out).toMatchObject({ ext: "png", width: 512, height: 128 });
    expect(out.data.includes(Buffer.from("Secret Person"))).toBe(false);
    expect(PNG.sync.read(out.data).width).toBe(512);
    expect(processLogo(pngWithText(100, 50))).toMatchObject({ width: 100, height: 50 });
  });

  test("WebP keeps image chunks only; oversize → 413", () => {
    const out = processLogo(webp(300, 200, ["EXIF", "XMP "]));
    expect(out).toMatchObject({ ext: "webp", width: 300, height: 200 });
    expect(out.data.includes(Buffer.from("GPS"))).toBe(false);
    expect(sniff(out.data)).toBe("webp");
    expect(code(() => processLogo(webp(800, 200)))).toBe("PAYLOAD_TOO_LARGE");
    expect(code(() => processLogo(webp(10, 10, ["ANIM"])))).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test("type by signature: SVG/HTML named .png → 415; > 1 MB → 413", () => {
    expect(code(() => processLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(code(() => processLogo(Buffer.from("<html><script>1</script></html>")))).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(code(() => processLogo(Buffer.alloc(1_048_577)))).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("V3-18: the name of a new system from its first message", () => {
  const brief = (id: string) =>
    (
      JSON.parse(readFileSync(new URL(`../../../tools/eval/briefs/${id}.json`, import.meta.url), "utf8")) as {
        text: string;
      }
    ).text;
  const NAMES: Readonly<Record<string, string>> = {
    "v3-01-interior-studio": "Линия",
    "v3-02-dental-booking": "Стоматологическая клиника",
    "v3-03-cleaning-crm": "Клининговая компания",
    "v3-04-karelia-tours": "Турфирма",
    "v3-05-ceramics-shop": "Керамическая мастерская",
  };

  test("the business name of the owner's words, never his sentence cut off; a business name is kept", () => {
    for (const [id, want] of Object.entries(NAMES)) {
      const text = brief(id);
      expect(nameFromPrompt(text), id).toBe(want);
      // A name of the business stays at the plan's approval (not «auto»); the cut name of an older system is replaced.
      expect(isAutoName(want, text), id).toBe(false);
      const legacy = (text.split(/[.!?\n]/)[0] ?? "").slice(0, 60).trim();
      expect(isAutoName(legacy, text), id).toBe(true);
      // The owner's own name is never «auto».
      expect(isAutoName("Моя студия", text), id).toBe(false);
    }
  });

  test("no business in the words: the first clause cut on a word boundary, «auto» until the plan names it", () => {
    const text = "Нужна система учёта заявок на ремонт техники для нашего сервисного центра в Самаре, срочно";
    const name = nameFromPrompt(text);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).not.toMatch(/(?:\s(?:в|на|для|и)|[,:;—-])$/);
    expect(text.toLowerCase()).toContain(name.toLowerCase());
    expect(isAutoName(name, text)).toBe(true);
    expect(nameFromPrompt("   ")).toBe("Новая система");
  });
});

describe("slugs and paths", () => {
  test("slugs match runtime.yaml#routing.system_slug", () => {
    for (const p of [
      "Форум «Северный ритейл» на 600 человек",
      "a",
      "123 заказов",
      "---",
      "Запись к мастеру маникюра",
    ]) {
      const s = makeSlug(p);
      expect(s).toMatch(SLUG_RE);
      expect(s).not.toContain("--");
      expect(RESERVED_SLUGS.has(s)).toBe(false);
    }
    expect(makeSlug("Форум ритейл")).toMatch(/^forum-riteyl-[a-z0-9]{5}$/);
  });

  test("revision paths", () => {
    for (const ok of ["ui/a.tsx", "functions/x/y.ts", "assets/logo.png"]) expect(isSafePath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "ui/../x", "ui/./x", "ui//x", "ui\\x", "ui/\0x", ".."])
      expect(isSafePath(bad)).toBe(false);
  });
});

describe("blob store", () => {
  test("a flipped byte → INTEGRITY", async () => {
    const root = mkdtempSync(join(tmpdir(), "wz-blob-"));
    const store = new BlobStore(root);
    const data = Buffer.from("export const a = 1;\n");
    const sha = sha256(data);
    const fakeDb = {
      insertInto: () => ({ values: () => ({ onConflict: () => ({ execute: async () => {} }) }) }),
    };
    await store.put(fakeDb as never, data, "text/plain");
    expect((await store.get(sha)).toString()).toBe(data.toString());
    writeFileSync(join(root, BlobStore.key(sha)), "export const a = 2;\n");
    await expect(store.get(sha)).rejects.toBeInstanceOf(IntegrityError);
    rmSync(root, { recursive: true, force: true });
  });
});
