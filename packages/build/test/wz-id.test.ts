// ui-kit.yaml#wz_id: plugin transform in isolation.
import { describe, expect, test } from "vitest";
import { fileKey, injectWzIds } from "../src/index.js";

const F = "ui/pages/landing.tsx";
const K = fileKey(F);

describe("injectWzIds", () => {
  test("fileKey = first 8 hex of sha256(path)", () => {
    expect(fileKey("ui/pages/landing.tsx")).toMatch(/^[0-9a-f]{8}$/);
    expect(fileKey("ui/a.tsx")).not.toBe(fileKey("ui/b.tsx"));
  });

  test("only ui-kit elements, in source order; aliases, members and namespaces", () => {
    const src = [
      'import { Button as B, AppShell, type Field } from "@wizard/ui-kit";',
      'import * as Kit from "@wizard/ui-kit";',
      "const Local = () => <div />;",
      "export default function P() {",
      "  return (",
      "    <AppShell>",
      "      <div><B onClick={() => 1}>Ок</B></div>",
      '      <AppShell.Login role="x" />',
      "      <Kit.Badge {...{ tone: 1 }} />",
      "      <Local />",
      '      {[1, 2].map((i) => <B key={i} wzId="manual">{i}</B>)}',
      "    </AppShell>",
      "  );",
      "}",
    ].join("\n");
    const r = injectWzIds(F, src);
    expect(r.entries).toEqual([
      [`${K}:1`, { file: F, line: 6, componentName: "AppShell" }],
      [`${K}:2`, { file: F, line: 7, componentName: "Button" }],
      [`${K}:3`, { file: F, line: 8, componentName: "AppShell.Login" }],
      [`${K}:4`, { file: F, line: 9, componentName: "Badge" }],
      [`${K}:5`, { file: F, line: 11, componentName: "Button" }],
    ]);
    expect(r.code).toContain(`<AppShell wzId="${K}:1">`);
    expect(r.code).toContain(`<B onClick={() => 1} wzId="${K}:2">`);
    expect(r.code).toContain(`<AppShell.Login role="x" wzId="${K}:3" />`);
    expect(r.code).toContain(`<Kit.Badge {...{ tone: 1 }} wzId="${K}:4" />`);
    expect(r.code).toContain("<Local />");
    // A .map() element keeps one id; the injected prop comes last and overrides a hand-written one.
    expect(r.code).toContain(`<B key={i} wzId="manual" wzId="${K}:5">`);
    expect(r.code.split("\n").length).toBe(src.split("\n").length);
  });

  test("no ui-kit import → source unchanged; same input → same output", () => {
    const src = "export default () => <Button />;";
    expect(injectWzIds(F, src)).toEqual({ code: src, entries: [] });
    const kit = 'import { Button } from "@wizard/ui-kit";\nexport default () => <Button />;';
    expect(injectWzIds(F, kit)).toEqual(injectWzIds(F, kit));
  });

  test("type-only ui-kit imports are not components", () => {
    const src = 'import type { Button } from "@wizard/ui-kit";\nexport default () => <Button />;';
    expect(injectWzIds(F, src).entries).toEqual([]);
  });
});
