// V4-15: the source map of a system's pages — the texts and photos of the composer's pattern props and of free TSX
// mapped to their literals; data-wz-src on the elements of free TSX; an instant edit replaces exactly one literal and
// the file stays valid TSX (it builds).

import ts from "typescript";
import { describe, expect, test } from "vitest";
import { createPageComposer } from "../../agents/src/builder/index.js";
import { composeContext } from "../../agents/test/v3-compose-fixtures.js";
import { PATTERNS } from "../../ui-kit/src/v3/patterns/index.js";
import { annotateSource, applyLiteralEdits, buildSourceMap, fileLiterals } from "../src/source-map/index.js";
import { injectWzIds } from "../src/wz-id.js";

const FREE = `import { LeadForm } from "@wizard/sdk/v4";
export default function Home() {
  return (
    <main>
      <h1 className="text-display">Лечим зубы без боли</h1>
      <p>Перезвоним за {"15 минут"}</p>
      <img src="/_wizard/photos/00000000-0000-4000-8000-000000000000/1600" alt="Кабинет у окна" />
      <a href="/services">Цены</a>
      <LeadForm entity="lead" submit="Записаться" />
    </main>
  );
}
`;

async function clinic(): Promise<Map<string, string>> {
  const base = composeContext();
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  const files = new Map(base.files);
  for (const [p, v] of out.files) if (v !== null) files.set(p, v);
  return files;
}

const syntaxOk = (file: string, text: string) =>
  (
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) as unknown as {
      parseDiagnostics: unknown[];
    }
  ).parseDiagnostics.length === 0;

describe("V4-15: source map", () => {
  test('free TSX: texts, an {"…"} child, the photo and its alt, a component\'s prop; links and bindings are not texts', () => {
    const l = fileLiterals("ui/pages/site/Home.tsx", FREE);
    expect(l.map((x) => `${x.kind}:${x.value}`)).toEqual([
      "text:Лечим зубы без боли",
      "text:Перезвоним за",
      "text:15 минут",
      "image:/_wizard/photos/00000000-0000-4000-8000-000000000000/1600",
      "alt:Кабинет у окна",
      "text:Цены",
      "text:Записаться",
    ]);
    for (const x of l) expect(x.ref).toMatch(/^[0-9a-f]{8}:\d+$/);
  });

  test("free TSX: data-wz-src on the elements that show the literals, on the same lines", () => {
    const out = annotateSource("ui/pages/site/Home.tsx", FREE);
    const refs = Object.fromEntries(
      fileLiterals("ui/pages/site/Home.tsx", FREE).map((x) => [x.value, x.ref]),
    );
    expect(out).toContain(`<h1 data-wz-src="${refs["Лечим зубы без боли"]}"`);
    expect(out).toContain(`<p data-wz-src="${refs["Перезвоним за"]} ${refs["15 минут"]}"`);
    expect(out).toContain(
      `<img data-wz-src="${refs["/_wizard/photos/00000000-0000-4000-8000-000000000000/1600"]} ${refs["Кабинет у окна"]}"`,
    );
    expect(out).not.toContain("<main data-wz-src");
    expect(out.split("\n").length).toBe(FREE.split("\n").length);
    expect(syntaxOk("x.tsx", out)).toBe(true);
  });

  test("the composer's pages: hero title, lead and photo of the pattern props are mapped; the library is not", async () => {
    const files = await clinic();
    const map = Object.values(buildSourceMap(files));
    expect(map.some((x) => x.file.startsWith("ui/patterns/"))).toBe(false);
    const home = map.filter((x) => x.file === "ui/pages/site/Home.tsx");
    const values = home.map((x) => x.value);
    expect(values).toContain("Лечим зубы без боли и очередей");
    expect(values).toContain("Оставьте заявку — перезвоним за 15 минут");
    expect(home.some((x) => x.kind === "image" && x.value.startsWith("/_wizard/photos/"))).toBe(true);
    expect(values).not.toContain("/services");
    expect(values).not.toContain("lead");
  });

  test("each literal of a section carries the wzId of its innermost pattern: one value in two sections stays apart", async () => {
    const files = await clinic();
    const file = "ui/pages/site/Home.tsx";
    const source = files.get(file) as string;
    const ids = new Map(injectWzIds(file, annotateSource(file, source)).entries);
    const home = fileLiterals(file, source);
    expect(home.length).toBeGreaterThan(0);
    for (const l of home) expect(ids.has(l.wz as string)).toBe(true);
    const title = home.find((x) => x.value === "Лечим зубы без боли и очередей");
    expect(ids.get(title?.wz as string)?.componentName).toMatch(/hero/i);

    const twice = `import Header from "../../patterns/header-simple";
import Hero from "../../patterns/hero-split";
export default function Home() {
  return (
    <>
      <Header brand="Клиника в Казани" />
      <Hero title="Клиника в Казани" lead="Без очередей" />
      <p>Клиника в Казани</p>
    </>
  );
}
`;
    const l = fileLiterals(file, twice);
    expect(l.map((x) => `${x.value}@${x.wz ?? "-"}`)).toEqual([
      `Клиника в Казани@${l[0]?.ref.split(":")[0]}:1`,
      `Клиника в Казани@${l[0]?.ref.split(":")[0]}:2`,
      `Без очередей@${l[0]?.ref.split(":")[0]}:2`,
      "Клиника в Казани@-",
    ]);
  });

  test("an instant edit replaces exactly its literal; quotes and braces stay valid TSX; bad values are refused", async () => {
    const files = await clinic();
    const map = Object.values(buildSourceMap(files));
    const title = map.find((x) => x.value === "Лечим зубы без боли и очередей");
    const photo = map.find((x) => x.kind === "image" && x.file === "ui/pages/site/Home.tsx");
    if (!title || !photo) throw new Error("fixture");
    const r = applyLiteralEdits(files, [
      { ref: title.ref, value: 'Лечим «зубы» без "боли" {и} очередей' },
      { ref: photo.ref, value: "/_wizard/photos/11111111-1111-4111-8111-111111111111/1600" },
    ]);
    if (!r.ok) throw new Error(r.message);
    expect([...r.files.keys()]).toEqual(["ui/pages/site/Home.tsx"]);
    const next = r.files.get("ui/pages/site/Home.tsx") as string;
    const before = files.get("ui/pages/site/Home.tsx") as string;
    expect(syntaxOk("Home.tsx", next)).toBe(true);
    const after = fileLiterals("ui/pages/site/Home.tsx", next).map((x) => x.value);
    expect(after).toContain('Лечим «зубы» без "боли" {и} очередей');
    expect(after).toContain("/_wizard/photos/11111111-1111-4111-8111-111111111111/1600");
    expect(after.length).toBe(fileLiterals("ui/pages/site/Home.tsx", before).length);

    const free = new Map([["ui/pages/site/Free.tsx", FREE]]);
    const h1 = fileLiterals("ui/pages/site/Free.tsx", FREE)[0];
    const r2 = applyLiteralEdits(free, [{ ref: h1?.ref as string, value: "Цены {от} 1000 ₽ <без> скрытых" }]);
    if (!r2.ok) throw new Error(r2.message);
    const t2 = r2.files.get("ui/pages/site/Free.tsx") as string;
    expect(syntaxOk("Free.tsx", t2)).toBe(true);
    expect(fileLiterals("ui/pages/site/Free.tsx", t2)[0]?.value).toBe("Цены {от} 1000 ₽ <без> скрытых");

    expect(applyLiteralEdits(files, [{ ref: "00000000:1", value: "x" }])).toMatchObject({
      ok: false,
      code: "UNKNOWN_REF",
    });
    expect(applyLiteralEdits(files, [{ ref: title.ref, value: "  " }])).toMatchObject({
      ok: false,
      code: "INVALID_VALUE",
    });
    expect(applyLiteralEdits(files, [{ ref: photo.ref, value: "https://evil.example/x.png" }])).toMatchObject(
      {
        ok: false,
        code: "INVALID_VALUE",
      },
    );
  });
});
