// @vitest-environment happy-dom
// M1-08 S-code: file tree of a revision, read-only viewer with highlighting, «весь файл / изменения ревизии».
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import type { Revision } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { highlightLines } from "../src/code/highlight.js";
import { hunks, lineDiff } from "../src/code/linediff.js";
import { CodeScreen } from "../src/screens/code/CodeScreen.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "11111111-1111-4111-8111-111111111111";
const V1 = 'export function Landing() {\n  return <h1 className="t">Форум</h1>;\n}\n';
const V2 = 'export function Landing() {\n  // greeting\n  return <h1 className="t">Форум 2026</h1>;\n}\n';
const FILES: Record<number, Record<string, string>> = {
  1: { "ui/pages/landing.tsx": V1, "functions/stats.ts": "export const n = 1;\n" },
  2: { "ui/pages/landing.tsx": V2, "functions/stats.ts": "export const n = 1;\n" },
};
const revision = (v: number): Revision => ({
  version: v,
  parentVersion: v > 1 ? v - 1 : null,
  author: "agent",
  createdAt: "2026-09-30T00:00:00Z",
  spec: {},
  ops: [],
  files: Object.entries(FILES[v] ?? {}).map(([path, src]) => ({
    path,
    sha256: `sha:${src}`,
    size: src.length,
  })),
});

function fakeApi(): ApiClient {
  return {
    getOrgSettings: async () => ({}),
    getSystem: async () => ({ system: { id: SYS, name: "Форум", draftRevision: 2 }, messages: [] }),
    listRevisions: async () => ({ items: [revision(2), revision(1)] }),
    getRevision: async (_: string, v: number) => revision(v),
    getFileText: async (_: string, path: string, rev: number) => FILES[rev]?.[path] ?? "",
  } as unknown as ApiClient;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function open(url: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      h(
        PlatformProvider,
        { api: fakeApi() } as ComponentProps<typeof PlatformProvider>,
        h(CodeScreen, { systemId: SYS }),
      ),
    ),
  );
  const el = container;
  await waitFor(() =>
    (el.querySelector('[data-testid="code-viewer"] ol')?.textContent ?? "").includes("Landing"),
  );
  return el;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(cond()).toBe(true);
}

describe("S-code", () => {
  test("the tree lists ui/ and functions/, the first ui file opens read-only (no textarea, no contenteditable)", async () => {
    const el = await open(`/s/${SYS}/code?rev=2`);
    const files = [...el.querySelectorAll('[data-testid="code-file"]')].map((a) =>
      a.getAttribute("data-path"),
    );
    expect(files).toEqual(["ui/pages/landing.tsx", "functions/stats.ts"]);
    expect(window.location.search).toContain("path=ui%2Fpages%2Flanding.tsx");
    const viewer = el.querySelector('[data-testid="code-viewer"]');
    expect(viewer?.textContent).toContain("Форум 2026");
    expect(viewer?.querySelector(".keyword, [class*=keyword]")?.textContent).toBe("export");
    expect(el.querySelectorAll("textarea, [contenteditable]").length).toBe(0);
    // Changed in this revision: marked in the tree.
    expect(el.querySelector('[data-path="ui/pages/landing.tsx"]')?.textContent).toContain("•");
    expect(el.querySelector('[data-path="functions/stats.ts"]')?.textContent).not.toContain("•");
  });

  test("«изменения ревизии» shows added and removed lines against the parent revision", async () => {
    const el = await open(`/s/${SYS}/code?rev=2&path=ui%2Fpages%2Flanding.tsx&view=changes`);
    await waitFor(() => el.querySelectorAll("[data-diff]").length > 0);
    const add = [...el.querySelectorAll('[data-diff="add"]')].map((x) => x.textContent);
    const del = [...el.querySelectorAll('[data-diff="del"]')].map((x) => x.textContent);
    expect(add.some((t) => t?.includes("// greeting"))).toBe(true);
    expect(add.some((t) => t?.includes("Форум 2026"))).toBe(true);
    expect(del.some((t) => t?.includes("Форум</h1>"))).toBe(true);
  });
});

describe("highlight and line diff", () => {
  test("tokens keep text exactly; comments and template strings span lines", () => {
    const src = "const a = `x\ny`; /* c\nd */ return 42;\n// e";
    const lines = highlightLines(src);
    expect(lines.map((l) => l.map((t) => t.v).join(""))).toEqual(src.split("\n"));
    expect(lines[0]?.[0]).toEqual({ k: "keyword", v: "const" });
    expect(lines[1]?.find((t) => t.k === "string")?.v).toBe("y`");
    expect(lines[2]?.find((t) => t.k === "comment")?.v).toBe("d */");
    expect(lines[2]?.find((t) => t.k === "number")?.v).toBe("42");
  });

  test("lineDiff keeps order and hunks collapse unchanged runs", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l15", "L15");
    const d = lineDiff(a, b) ?? [];
    expect(d.filter((x) => x.t === "del").map((x) => x.text)).toEqual(["l15"]);
    expect(d.filter((x) => x.t === "add").map((x) => [x.text, x.n])).toEqual([["L15", 16]]);
    const rows = hunks(d);
    expect(rows[0]).toEqual({ t: "gap", skipped: 12 });
    expect(rows.at(-1)).toEqual({ t: "gap", skipped: 11 });
    expect(lineDiff("", "x")).toEqual([{ t: "add", text: "x", n: 1 }]);
  });
});
