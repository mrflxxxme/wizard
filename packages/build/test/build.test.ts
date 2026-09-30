// backlog M0-20: forum build (forum.json + specs/runtime/examples), determinism, wzId stability, prod.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fileKey } from "../src/index.js";
import { build, clientText, forumFiles, PKG_ROOT, REPO_ROOT } from "./helpers.js";

const WZ_ID_RE = /^[0-9a-f]{8}:[0-9]+$/;

function importsOf(esm: string): string[] {
  return [...esm.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*"([^"]+)"/gm)].map((m) => m[1] as string);
}

describe("buildSystem: forum, draft", () => {
  test("builds ui and functions bundles", async () => {
    const r = await build();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const paths = [...r.client.keys()].sort();
    expect(paths).toContain("index.html");
    expect(paths.some((p) => /^assets\/index-[a-f0-9]{12}\.js$/.test(p))).toBe(true);
    expect(r.manifest.entry.script).toMatch(/^assets\/index-[a-f0-9]{12}\.js$/);

    const html = new TextDecoder().decode(r.client.get("index.html"));
    expect(html).toContain(`<script type="module" src="/${r.manifest.entry.script}"></script>`);
    expect(html).toContain('<script src="/_wizard/bridge.js"></script>');
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("<title>Форум «Северный ритейл»</title>");
    expect(html).not.toMatch(/<script>(?!<)/); // no inline scripts (CSP script-src 'self')

    // Functions: ESM importing only @wizard/sdk, one named export per spec function.
    expect(new Set(importsOf(r.serverFunctions))).toEqual(new Set(["@wizard/sdk"]));
    for (const n of ["partnerQuota", "registerTicket", "sendReminder", "ticketAvailability"]) {
      expect(r.serverFunctions).toMatch(new RegExp(`\\bas ${n}\\b`));
    }
    expect(r.manifest.functions.names).toEqual([
      "partnerQuota",
      "registerTicket",
      "sendReminder",
      "ticketAvailability",
    ]);
    expect(r.serverFunctions).toContain("functions/lib/occupancy.ts");
  });

  test("functions bundle is loadable ESM with SDK definitions as exports", async () => {
    const r = await build();
    const file = join(PKG_ROOT, "test/.generated/functions.mjs");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.serverFunctions);
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown> & {
      default: Record<string, { kind?: unknown }>;
    };
    expect(Object.keys(mod.default).sort()).toEqual(r.manifest.functions.names);
    expect(mod.registerTicket).toBe(mod.default.registerTicket);
    expect(mod.default.registerTicket?.kind).toBe("mutation");
  });

  test("wz-map: every ui-kit element of every page, with file, line and component", async () => {
    const r = await build();
    const map = r.wzMap ?? {};
    const ids = Object.keys(map);
    expect(ids.length).toBeGreaterThan(10);
    const files = forumFiles();
    for (const id of ids) {
      expect(id).toMatch(WZ_ID_RE);
      const e = map[id];
      if (!e) throw new Error(id);
      expect(id.split(":")[0]).toBe(fileKey(e.file));
      const line = (files.get(e.file) ?? "").split("\n")[e.line - 1] ?? "";
      expect(line).toContain(`<${e.componentName}`);
    }
    expect(new Set(Object.values(map).map((e) => e.file))).toEqual(
      new Set(["ui/Landing.tsx", "ui/Moderation.tsx", "ui/MyTicket.tsx", "ui/Scanner.tsx"]),
    );
    // Components receive the id: it is in the bundle as a prop.
    const js = clientText(r);
    for (const id of ids) expect(js).toContain(`wzId:"${id}"`);
  });

  test("deterministic: two builds give identical bytes, no host paths leak", async () => {
    const [a, b] = [await build(), await build()];
    expect([...a.client.keys()]).toEqual([...b.client.keys()]);
    for (const [p, bytes] of a.client)
      expect(Buffer.from(bytes).equals(Buffer.from(b.client.get(p) ?? []))).toBe(true);
    expect(a.serverFunctions).toBe(b.serverFunctions);
    expect(JSON.stringify(a.wzMap)).toBe(JSON.stringify(b.wzMap));
    expect(a.manifest).toEqual(b.manifest);
    for (const text of [clientText(a), a.serverFunctions]) {
      expect(text).not.toContain(REPO_ROOT);
      expect(text).not.toContain("wz-build-");
      expect(text).not.toContain(tmpdir());
    }
  });

  test("wzId stable: editing another file does not change ids in this one", async () => {
    const before = await build();
    const files = forumFiles();
    const mod = files.get("ui/Moderation.tsx") ?? "";
    files.set(
      "ui/Moderation.tsx",
      mod.replace(
        "export default function Moderation() {",
        "const X = () => <Button>Ещё</Button>;\nexport default function Moderation() {",
      ),
    );
    const after = await build({ files });
    expect(after.ok).toBe(true);
    const pick = (m: typeof before.wzMap, file: string) =>
      JSON.stringify(Object.entries(m ?? {}).filter(([, e]) => e.file === file));
    for (const f of ["ui/Landing.tsx", "ui/MyTicket.tsx", "ui/Scanner.tsx"]) {
      expect(pick(after.wzMap, f)).toBe(pick(before.wzMap, f));
    }
    expect(pick(after.wzMap, "ui/Moderation.tsx")).not.toBe(pick(before.wzMap, "ui/Moderation.tsx"));
  });

  test("platformOrigin: meta in draft only; invalid origin fails", async () => {
    const draft = await build({ platformOrigin: "http://localhost:5173" });
    expect(new TextDecoder().decode(draft.client.get("index.html"))).toContain(
      '<meta name="wz-platform-origin" content="http://localhost:5173">',
    );
    const prod = await build({ env: "prod", platformOrigin: "http://localhost:5173" });
    expect(new TextDecoder().decode(prod.client.get("index.html"))).not.toContain("wz-platform-origin");
    const bad = await build({ platformOrigin: 'http://localhost:5173/x"><script>' });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.id).toBe("G0-BUILD-01");
  });

  test("missing page or function file → G0-BUILD-01 blocker", async () => {
    const files = forumFiles();
    files.delete("ui/Scanner.tsx");
    files.delete("functions/sendReminder.ts");
    const r = await build({ files });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.id, e.severity, e.status, e.file])).toEqual([
      ["G0-BUILD-01", "blocker", "fail", "ui/Scanner.tsx"],
      ["G0-BUILD-01", "blocker", "fail", "functions/sendReminder.ts"],
    ]);
    expect(r.client.size).toBe(0);
  });

  test("UI bundle over 2 MB fails", async () => {
    const files = forumFiles();
    files.set("ui/Big.ts", `export const BIG = "${"x".repeat(2_200_000)}";`);
    files.set(
      "ui/Scanner.tsx",
      `import { BIG } from "./Big";\n${files.get("ui/Scanner.tsx")}\nconsole.log(BIG);`,
    );
    const r = await build({ files });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message_ru).toContain("2 МБ");
  });
});

describe("buildSystem: prod", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("no wz-map and no bridge; data-wz ids stay; builds without network", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network is not allowed during build");
    });
    const r = await build({ env: "prod" });
    expect(r.errors).toEqual([]);
    expect(r.wzMap).toBeNull();
    expect(r.manifest.wzMap).toBe(false);
    expect(r.manifest.env).toBe("prod");
    const all = clientText(r);
    expect(all).not.toContain("bridge.js");
    expect(all).not.toContain("_wizard/bridge");
    expect([...r.client.keys()].some((p) => p.includes("wz-map"))).toBe(false);
    expect(all).toContain(`"${fileKey("ui/Landing.tsx")}:1"`);
    expect(all).not.toContain(REPO_ROOT);
    const again = await build({ env: "prod" });
    expect(again.manifest).toEqual(r.manifest);
    expect(all).not.toMatch(/https?:\/\/(?!www\.w3\.org|reactjs\.org|react\.dev)/);
  });
});
