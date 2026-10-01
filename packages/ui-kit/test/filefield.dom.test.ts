// @vitest-environment happy-dom
// M2-14 FileField (ui-kit.yaml#components.FileField): upload via the DataSource (POST /api/files), name and size, no
// preview; SVG (by type or by signature) and > 10 МБ → error at the field in Russian; RecordForm maps file → FileField
// and sends the fileId with consent (a file field without pii is basic).
import type { AppSpec, Entity } from "@wizard/appspec";
import { act, createElement as h, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { FileField, formatFileSize, RecordForm, toRoleSpec } from "../src/index.js";
import { createMemoryDataSource, type MemoryDataSource } from "../src/testing/index.js";
import { click, type Rendered, render, type } from "./helpers/dom.js";

const PDF = "%PDF-1.4\n%%EOF\n";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

function filesSpec(): AppSpec {
  const spec = structuredClone(forum);
  const app = spec.entities.find((e) => e.name === "speaker_application") as Entity;
  app.fields.push({ name: "slides", label: "Презентация", type: "file" });
  return spec;
}

let r: Rendered | undefined;
afterEach(() => r?.unmount());

async function choose(input: HTMLElement, file: File) {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Upload resolves on the next ticks.
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
}

function setup(user = "u_speaker") {
  const spec = filesSpec();
  const f = forumFixture();
  const ds = createMemoryDataSource(spec, f.rows, { users: f.users, userId: user });
  return { spec, ds };
}

function Harness({
  initial = null as string | null,
  log,
}: {
  initial?: string | null;
  log: (v: string | null) => void;
}) {
  const [v, setV] = useState<string | null>(initial);
  return h(FileField, {
    name: "slides",
    label: "Презентация",
    value: v,
    required: true,
    onChange: (x: string | null) => {
      log(x);
      setV(x);
    },
  });
}

async function mountField(ds: MemoryDataSource, spec: AppSpec, initial: string | null = null) {
  const changes: (string | null)[] = [];
  r = await render(h(Harness, { initial, log: (v) => changes.push(v) }), {
    spec: toRoleSpec(spec, "speaker"),
    ds,
  });
  return changes;
}

describe("FileField", () => {
  test("PDF uploads: onChange(fileId), name and size, hint with types; no preview element", async () => {
    const { spec, ds } = setup();
    const changes = await mountField(ds, spec);
    const input = r?.$("wz-filefield-slides-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/jpeg,image/png,image/webp,application/pdf");
    expect(r?.$("wz-filefield-slides").textContent).toContain("JPEG, PNG, WebP, PDF, до 10 МБ");
    await choose(input, new File([PDF.repeat(100)], "Доклад.pdf", { type: "application/pdf" }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(r?.$("wz-filefield-slides-name").textContent).toBe("Доклад.pdf");
    expect(r?.$("wz-filefield-slides-size").textContent).toBe(formatFileSize(PDF.length * 100));
    expect(r?.container.querySelector("img, embed, iframe, object")).toBeNull();
    expect(ds.calls.filter((c) => c.op === "files.upload")).toEqual([
      { op: "files.upload", args: ["Доклад.pdf", { field: "slides" }] },
    ]);
    await click(r?.$("wz-filefield-slides-remove") as HTMLElement);
    expect(changes.at(-1)).toBeNull();
  });

  test("SVG → «Такой тип файла загрузить нельзя»: by type before upload, by signature from the server", async () => {
    const { spec, ds } = setup();
    const changes = await mountField(ds, spec);
    const input = r?.$("wz-filefield-slides-input") as HTMLInputElement;
    await choose(input, new File([SVG], "logo.svg", { type: "image/svg+xml" }));
    expect(r?.$("wz-filefield-slides-error").textContent).toBe("Такой тип файла загрузить нельзя");
    expect(ds.calls.some((c) => c.op === "files.upload")).toBe(false);
    // Disguised as PNG: the browser type passes, the signature does not (415 from the data source).
    await choose(input, new File([SVG], "photo.png", { type: "image/png" }));
    expect(ds.calls.filter((c) => c.op === "files.upload")).toHaveLength(1);
    expect(r?.$("wz-filefield-slides-error").textContent).toBe("Такой тип файла загрузить нельзя");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(r?.$("wz-filefield-slides-error").id);
    expect(changes).toEqual([]);
  });

  test("> 10 МБ → «Файл больше 10 МБ» without an upload", async () => {
    const { spec, ds } = setup();
    await mountField(ds, spec);
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    await choose(r?.$("wz-filefield-slides-input") as HTMLElement, big);
    expect(r?.$("wz-filefield-slides-error").textContent).toBe("Файл больше 10 МБ");
    expect(ds.calls.some((c) => c.op === "files.upload")).toBe(false);
  });

  test("an existing value shows the stored name and size", async () => {
    const { spec, ds } = setup();
    const info = await ds.files.upload(new File([PDF], "Старый.pdf", { type: "application/pdf" }), {
      field: "slides",
    });
    await mountField(ds, spec, info.fileId);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(r?.$("wz-filefield-slides-name").textContent).toBe("Старый.pdf");
    expect(r?.$("wz-filefield-slides-size").textContent).toBe("15 Б");
  });

  test("formatFileSize: Б, КБ, МБ in ru-RU", () => {
    expect(formatFileSize(512)).toBe("512 Б");
    expect(formatFileSize(1536)).toBe("1,5 КБ");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 МБ");
  });
});

describe("RecordForm with a file field", () => {
  test("default fields include the file field; the fileId is sent with consent (file = pii basic)", async () => {
    const { spec, ds } = setup();
    r = await render(h(RecordForm, { entity: "speaker_application" }), {
      spec: toRoleSpec(spec, "speaker"),
      ds,
    });
    expect(r.$("wz-filefield-slides")).toBeTruthy();
    const input = (name: string) =>
      r?.$(`wz-field-${name}`).querySelector("input, textarea") as HTMLInputElement;
    await type(input("full_name"), "Анна Докладчикова");
    await type(input("email"), "anna@example.test");
    await type(input("topic"), "Доклад");
    await type(input("abstract"), "Тезисы");
    await choose(
      r.$("wz-filefield-slides-input"),
      new File([PDF], "slides.pdf", { type: "application/pdf" }),
    );
    const fileId = [...ds.files.stored().keys()][0];
    expect(fileId).toBeTruthy();
    await click(r.q('[data-testid="wz-consent--recordform"] input'));
    await click(r.$("wz-recordform-submit"));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(ds.rows("speaker_application").at(-1)).toMatchObject({
      slides: fileId,
      speaker_user: "u_speaker",
    });
    const create = ds.calls.find((c) => c.op === "create" && c.entity === "speaker_application");
    expect(create?.args[1]).toEqual({ consent: true });
  });
});
