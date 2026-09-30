import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT, sliceFile, sliceTask } from "../slice.mjs";
import { parseSpecRef, parseYamlFiles, runChecks } from "../validate.mjs";

const tmp = mkdtempSync(join(tmpdir(), "wz-slice-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Parses YAML text through the same PyYAML loader as validate.mjs. */
function parseYaml(text) {
  const p = join(tmp, `s${n++}.yaml`);
  writeFileSync(p, text);
  const r = parseYamlFiles([p])[p];
  if ("error" in r) throw new Error(r.error);
  return r.ok;
}
const load = (file) => parseYaml(readFileSync(join(ROOT, file), "utf8"));
const rank = (m) => Number(/^M(\d+)/.exec(String(m))?.[1]);
const tasks = () => load("specs/backlog.yaml").tasks;

describe("slice.mjs: --milestone", () => {
  it("api.yaml: only operations x-milestone ≤ M0 and the components they reach by $ref", () => {
    const full = load("specs/platform/api.yaml");
    const out = parseYaml(sliceFile("specs/platform/api.yaml", { milestone: "M0" }));
    const ops = (doc) =>
      Object.values(doc.paths).flatMap((item) =>
        Object.entries(item)
          .filter(([k]) => k !== "parameters")
          .map(([, op]) => op),
      );
    const want = ops(full)
      .filter((op) => rank(op["x-milestone"]) <= 0)
      .map((op) => op.operationId);
    expect(want.length).toBeGreaterThan(5);
    expect(ops(out).map((op) => op.operationId)).toEqual(want);
    expect(ops(out).every((op) => rank(op["x-milestone"]) === 0)).toBe(true);
    expect(out.info["x-auth"].M0).toBeDefined();
    expect(out.info["x-auth"].M1).toBeUndefined();

    // Every $ref in the slice resolves inside it, and every kept component is reachable.
    const refs = new Set();
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object")
        for (const [k, v] of Object.entries(x)) k === "$ref" ? refs.add(v) : walk(v);
    };
    walk(out);
    for (const r of refs) {
      const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(r);
      expect(out.components[section]?.[name], r).toBeDefined();
    }
    const kept = Object.entries(out.components)
      .filter(([s]) => s !== "securitySchemes")
      .flatMap(([s, v]) => Object.keys(v).map((k) => `#/components/${s}/${k}`));
    expect(kept.filter((k) => !refs.has(k))).toEqual([]);
    expect(Object.keys(out.components.schemas).length).toBeLessThan(Object.keys(full.components.schemas).length);
  });

  it.each([
    ["specs/platform/db.yaml", (d) => ({ ...d.tables, ...d.views })],
    ["specs/ui/ui-kit.yaml", (d) => Object.fromEntries(d.components.map((c) => [c.name, c]))],
    ["specs/ui/platform-screens.yaml", (d) => Object.fromEntries(d.screens.map((s) => [s.id, s]))],
  ])("%s: elements with milestone ≤ M0 only", (file, items) => {
    const full = items(load(file));
    const out = items(parseYaml(sliceFile(file, { milestone: "M0" })));
    const want = Object.keys(full).filter((k) => rank(full[k].milestone) <= 0);
    expect(want.length).toBeLessThan(Object.keys(full).length);
    expect(Object.keys(out)).toEqual(want);
    // Inside kept elements only keys tagged with a later milestone (e.g. text_user_M3) disappear.
    const strip = (x) =>
      Array.isArray(x)
        ? x.map(strip)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x)
                .filter(([k]) => !(rank(/(?:^|_)(M\d+)$/.exec(k)?.[1]) > 0))
                .map(([k, v]) => [k, strip(v)]),
            )
          : x;
    for (const k of want) expect(out[k]).toEqual(strip(full[k]));
  });

  it("keys like M1/methods_M1 and '# M2' tags on collections are filtered, M0_M1 ranges are kept", () => {
    const deploy = parseYaml(sliceFile("specs/platform/deploy.yaml", { milestone: "M0" }));
    expect(deploy.local).toBeDefined();
    expect(deploy.cloud).toBeUndefined();
    expect(deploy.local.env_vars.M1).toBeUndefined();
    const iso = parseYaml(sliceFile("specs/security/isolation.yaml", { milestone: "M0" }));
    expect(iso.M0_M1).toBeDefined();
    expect(iso.M2).toBeUndefined();
    // Columns of M0 tables stay even when a comment mentions a later milestone.
    const db = parseYaml(sliceFile("specs/platform/db.yaml", { milestone: "M0" }));
    expect(db.tables.orgs).toEqual(load("specs/platform/db.yaml").tables.orgs);
  });
});

describe("slice.mjs: anchors", () => {
  const anchored = [...new Set(tasks().flatMap((t) => t.specs.map(String)))]
    .map(parseSpecRef)
    .filter((r) => r.anchor && /\.ya?ml$/.test(r.path));

  it("every YAML anchor in backlog specs slices to exactly its subtree", () => {
    expect(anchored.length).toBeGreaterThan(20);
    for (const { path, anchor } of anchored) {
      const doc = load(path);
      let node = doc;
      let isItem = false;
      for (const seg of anchor.split(".")) {
        isItem = Array.isArray(node);
        node = isItem ? node.find((x) => [x.id, x.name, x.key].includes(seg)) : node[seg];
      }
      const last = anchor.split(".").at(-1);
      const got = parseYaml(sliceFile(path, { anchor }));
      expect(got, `${path}#${anchor}`).toEqual(isItem ? [node] : { [last]: node });
    }
  });

  it("JSON pointer and markdown heading anchors", () => {
    const schema = JSON.parse(sliceFile("specs/appspec/appspec.schema.json", { anchor: "/$defs" }));
    expect(schema).toEqual(JSON.parse(readFileSync(join(ROOT, "specs/appspec/appspec.schema.json"), "utf8")).$defs);
    const md = sliceFile("specs/README.md", { anchor: "Правила спецификаций" });
    expect(md.startsWith("## Правила спецификаций")).toBe(true);
    expect(md).not.toContain("## Порядок чтения");
  });

  it("unknown anchor fails", () => {
    expect(() => sliceFile("specs/platform/workflows.yaml", { anchor: "no_such" })).toThrow(/якорь не найден/);
  });
});

describe("slice.mjs: --task", () => {
  it("M0-15: union of the task specs is ≤ 50% of the full files", () => {
    const { text, files } = sliceTask("M0-15");
    const full = files.reduce((s, f) => s + statSync(join(ROOT, f)).size, 0);
    const task = tasks().find((t) => t.id === "M0-15");
    for (const s of task.specs) expect(text).toContain(`# ==== ${parseSpecRef(s).path}`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(full * 0.5);
  });

  it("CLI prints the slice and fails on unknown task", () => {
    const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "tools/specs/slice.mjs"), ...args], { encoding: "utf8" });
    const ok = cli("specs/ui/ui-kit.yaml#components.AppShell");
    expect(ok.status).toBe(0);
    expect(ok.stdout.startsWith("- name: AppShell")).toBe(true);
    expect(cli("--task", "M9-99").status).toBe(1);
  });
});

describe("validate.mjs and repo files", () => {
  it("reports a broken anchor in backlog specs", () => {
    const root = join(tmp, "repo");
    cpSync(join(ROOT, "specs"), join(root, "specs"), { recursive: true });
    const p = join(root, "specs/backlog.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace('"specs/platform/workflows.yaml#execution"', '"specs/platform/workflows.yaml#no_such_anchor"'));
    const { errors } = runChecks(root);
    expect(errors).toContain('backlog M0-15: якорь не найден: specs/platform/workflows.yaml#no_such_anchor');
    expect(runChecks(ROOT).errors).toEqual([]);
  });

  it(".gitattributes merges CHANGELOG with union", () => {
    const lines = readFileSync(join(ROOT, ".gitattributes"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("specs/CHANGELOG.md merge=union");
  });
});
