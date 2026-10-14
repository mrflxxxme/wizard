// V4-06 sections written as code (ui/sections/<page>-<id>.tsx) know nothing of wzId: the page's element of each is
// wrapped in a div with data-wz-component and data-wz-id, so the owner can point at it («Укажи и измени») and the
// bridge tells apart the same text in two sections; the patterns keep the prop as before.
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { buildSourceMap, fileKey, injectWzIds } from "../src/index.js";

const PAGE = "ui/pages/site/Home.tsx";
const SOURCE = [
  'import HeaderFloating from "../../patterns/header-floating";',
  'import HomeHero from "../../sections/home-hero";',
  'import HomeSteps from "../../sections/home-steps";',
  "export default function HomePage() {",
  "  return (",
  "    <>",
  '      <HeaderFloating {...{"brand":{"name":"Белая линия"}}} />',
  '      <main id="main">',
  '        <div id="hero">',
  '          <HomeHero {...{"title":"Запишитесь на приём","lead":"Перезвоним за 15 минут"}} />',
  "        </div>",
  '        <div id="steps">',
  '          <HomeSteps {...{"title":"Запишитесь на приём"}} />',
  "        </div>",
  "      </main>",
  "    </>",
  "  );",
  "}",
].join("\n");

describe("V4-24: the sections written as code in the wz map", () => {
  test("each section's element is wrapped in a div with data-wz-component and data-wz-id; a pattern keeps the prop", () => {
    const key = fileKey(PAGE);
    const t = injectWzIds(PAGE, SOURCE);
    expect(t.entries.map(([id, e]) => [id, e.componentName, e.line])).toEqual([
      [`${key}:1`, "HeaderFloating", 7],
      [`${key}:2`, "HomeHero", 10],
      [`${key}:3`, "HomeSteps", 13],
    ]);
    expect(t.code).toContain(`<HeaderFloating {...{"brand":{"name":"Белая линия"}}} wzId="${key}:1" />`);
    expect(t.code).toContain(
      `<div data-wz-component="HomeHero" data-wz-id="${key}:2"><HomeHero {...{"title":"Запишитесь на приём","lead":"Перезвоним за 15 минут"}} /></div>`,
    );
    expect(t.code).toContain(`<div data-wz-component="HomeSteps" data-wz-id="${key}:3"><HomeSteps`);
    // Still TSX that parses.
    const sf = ts.createSourceFile(PAGE, t.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
  });

  test("the same text in two sections: each literal carries the wzId of its section", () => {
    const key = fileKey(PAGE);
    const map = buildSourceMap(new Map([[PAGE, SOURCE]]));
    const same = Object.values(map).filter((l) => l.value === "Запишитесь на приём");
    expect(same.map((l) => l.wz)).toEqual([`${key}:2`, `${key}:3`]);
  });
});
