#!/usr/bin/env node
// Срезы спек по якорю и вехе (M0-19, specs/README.md). Node 22, без зависимостей; YAML — python3 + PyYAML, как validate.mjs.
// Запуск:
//   node tools/specs/slice.mjs <file>[#a.b] [--milestone M0]
//   node tools/specs/slice.mjs --task M0-15 [--milestone M0 | --all]   (по умолчанию — веха задачи)
// Для YAML печатаются исходные строки (с комментариями) без отфильтрованных элементов.
// --milestone Mx убирает элементы (значения ключей и элементы списков) с milestone/x-milestone > Mx;
// для OpenAPI без якоря дополнительно убираются компоненты, не достижимые по $ref из оставшегося текста.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSpecRef, parseYamlFiles } from "./validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");

// Compact node tree with 0-based line spans: s = scalar, m = mapping, q = sequence.
const PY_COMPOSE = `
import sys, json, yaml
def conv(n):
    s = n.start_mark.line
    if isinstance(n, yaml.ScalarNode):
        e = n.end_mark.line
        if n.end_mark.column == 0 and e > s: e -= 1
        return {"t": "s", "v": n.value, "l0": s, "l1": e}
    if isinstance(n, yaml.SequenceNode):
        items = [conv(x) for x in n.value]
        e = max([s] + [x["l1"] for x in items])
        if n.flow_style: e = max(e, n.end_mark.line)
        return {"t": "q", "l0": s, "l1": e, "e": items}
    ents = [[k.value, k.start_mark.line, conv(v)] for k, v in n.value]
    e = max([s] + [x[2]["l1"] for x in ents])
    if n.flow_style: e = max(e, n.end_mark.line)
    return {"t": "m", "l0": s, "l1": e, "e": ents}
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.dumps(conv(yaml.compose(f))))
`;

function composeYaml(path) {
  const py = process.env.PYTHON || "python3";
  const r = spawnSync(py, ["-c", PY_COMPOSE, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`не удалось разобрать ${path}: ${r.error?.message ?? r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

const msRank = (v) => {
  const m = /^M(\d+)/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : null;
};
const scalarOf = (node, key) => {
  if (node?.t !== "m") return undefined;
  const e = node.e.find(([k]) => k === key);
  return e && e[2].t === "s" ? e[2].v : undefined;
};
const nodeMilestone = (node) => msRank(scalarOf(node, "x-milestone") ?? scalarOf(node, "milestone"));
// Keys "M2", "methods_M1", "M0_M1" (a range counts from its start) mark the value's milestone.
const keyMilestone = (key) => {
  const m = /(?:^|_)M(\d+)(?:_M\d+)?$/.exec(key);
  return m ? Number(m[1]) : null;
};
// "cloud:   # M2 (M2-06)" — a comment tag on the key line of a block collection (scalars keep their columns).
const commentMilestone = (line, value) => {
  if (value.t === "s") return null;
  const m = /^[^#]*:\s*#\s*M(\d+)\b/.exec(line ?? "");
  return m ? Number(m[1]) : null;
};
const itemKey = (node) => scalarOf(node, "id") ?? scalarOf(node, "name") ?? scalarOf(node, "key");
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

/** Finds the node for a dotted anchor; returns {node, l0} where l0 is the first line of the entry (key or list item). */
export function findAnchor(tree, anchor) {
  let node = tree;
  let l0 = tree.l0;
  for (const seg of anchor.split(".")) {
    if (node.t === "m") {
      const e = node.e.find(([k]) => k === seg);
      if (!e) return null;
      [, l0, node] = e;
    } else if (node.t === "q") {
      const it = node.e.find((x) => itemKey(x) === seg);
      if (!it) return null;
      node = it;
      l0 = it.l0;
    } else return null;
  }
  return { node, l0 };
}

/**
 * Marks line ranges to drop for elements whose milestone is later than `maxRank`.
 * Returns true when the node itself should be dropped (every child was dropped).
 */
function markMilestones(node, maxRank, drop, lines) {
  if (node.t === "s" || !node.e.length) return false;
  let dropped = 0;
  let methods = 0;
  let droppedMethods = 0;
  const entries = node.t === "m" ? node.e.map(([k, kl, v]) => ({ k, l0: kl, v })) : node.e.map((v) => ({ k: null, l0: v.l0, v }));
  for (const { k, l0, v } of entries) {
    const rank = nodeMilestone(v) ?? (k === null ? null : (keyMilestone(k) ?? commentMilestone(lines[l0], v)));
    const gone = (rank !== null && rank > maxRank) || markMilestones(v, maxRank, drop, lines);
    if (k && HTTP_METHODS.has(k)) {
      methods++;
      if (gone) droppedMethods++;
    }
    if (gone) {
      drop.push([l0, v.l1]);
      dropped++;
    }
  }
  // OpenAPI path item: all operations dropped → drop the path (parameters/summary do not keep it).
  if (methods > 0 && droppedMethods === methods) return true;
  return dropped === entries.length;
}

function collectRefs(node, skip, out) {
  if (skip(node)) return out;
  if (node.t === "m") {
    for (const [k, , v] of node.e) {
      if (k === "$ref" && v.t === "s") out.add(v.v);
      else collectRefs(v, skip, out);
    }
  } else if (node.t === "q") for (const x of node.e) collectRefs(x, skip, out);
  return out;
}

const overlaps = (drop, a, b) => drop.some(([x, y]) => x <= a && b <= y);

/** OpenAPI: drop components (except securitySchemes) unreachable by $ref from the kept document. */
function markUnreachableComponents(tree, drop) {
  const components = findAnchor(tree, "components")?.node;
  if (components?.t !== "m") return;
  const byRef = new Map();
  for (const [section, , sec] of components.e) {
    if (section === "securitySchemes" || sec.t !== "m") continue;
    for (const [name, kl, v] of sec.e) byRef.set(`#/components/${section}/${name}`, { l0: kl, v });
  }
  const isDropped = (n) => overlaps(drop, n.l0, n.l1);
  const inComponents = (n) => n === components || isDropped(n);
  const seen = new Set();
  const queue = [...collectRefs(tree, inComponents, new Set())];
  while (queue.length) {
    const ref = queue.pop();
    if (seen.has(ref) || !byRef.has(ref)) continue;
    seen.add(ref);
    for (const r of collectRefs(byRef.get(ref).v, isDropped, new Set())) queue.push(r);
  }
  for (const [ref, { l0, v }] of byRef) if (!seen.has(ref)) drop.push([l0, v.l1]);
}

/** Extends each dropped range upward over the comment lines directly attached to it. */
function withLeadingComments(lines, drop) {
  return drop.map(([a, b]) => {
    const indent = lines[a].search(/\S/);
    let s = a;
    while (s > 0 && /^\s*#/.test(lines[s - 1]) && lines[s - 1].search(/\S/) >= indent) s--;
    return [s, b];
  });
}

function dedent(lines) {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return Number.isFinite(ind) && ind > 0 ? lines.map((l) => l.slice(ind)) : lines;
}

/** Slices a YAML file; returns text. */
export function sliceYaml(path, anchor, milestone) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const tree = composeYaml(path);
  let target = { node: tree, l0: 0 };
  let last = lines.length - 1;
  if (anchor) {
    target = findAnchor(tree, anchor);
    if (!target) throw new Error(`якорь не найден: ${anchor}`);
    last = target.node.l1;
  }
  const maxRank = milestone ? msRank(milestone) : null;
  if (milestone && maxRank === null) throw new Error(`неверная веха: ${milestone}`);
  let drop = [];
  if (maxRank !== null) {
    if (anchor && nodeMilestone(target.node) !== null && nodeMilestone(target.node) > maxRank) return "";
    markMilestones(target.node, maxRank, drop, lines);
    if (!anchor && tree.t === "m" && scalarOf(tree, "openapi") !== undefined) markUnreachableComponents(tree, drop);
    drop = withLeadingComments(lines, drop);
  }
  const out = [];
  for (let i = target.l0; i <= last; i++) if (!drop.some(([a, b]) => a <= i && i <= b)) out.push(lines[i]);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return `${(anchor ? dedent(out) : out).join("\n")}\n`;
}

/** Markdown section whose heading contains the anchor (case-insensitive), up to the next heading of the same level. */
export function sliceMarkdown(path, anchor) {
  const text = readFileSync(path, "utf8");
  if (!anchor) return text;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(anchor.toLowerCase()));
  if (i < 0) throw new Error(`раздел не найден: ${anchor}`);
  const level = /^#+/.exec(lines[i])[0].length;
  let j = i + 1;
  while (j < lines.length && !(/^#{1,6}\s/.test(lines[j]) && /^#+/.exec(lines[j])[0].length <= level)) j++;
  return `${lines.slice(i, j).join("\n").trimEnd()}\n`;
}

function sliceJson(path, anchor) {
  let node = JSON.parse(readFileSync(path, "utf8"));
  if (anchor) {
    const segs = anchor.startsWith("/")
      ? anchor.slice(1).split("/").map((s) => decodeURIComponent(s).replace(/~1/g, "/").replace(/~0/g, "~"))
      : anchor.split(".");
    for (const s of segs) {
      if (node == null || typeof node !== "object" || !(s in node)) throw new Error(`якорь не найден: ${anchor}`);
      node = node[s];
    }
  }
  return `${JSON.stringify(node, null, 2)}\n`;
}

/** Slices one file (path relative to root). */
export function sliceFile(file, { anchor = null, milestone = null, root = ROOT } = {}) {
  const abs = join(root, file);
  if (!existsSync(abs)) throw new Error(`файл не найден: ${file}`);
  if (/\.ya?ml$/.test(file)) return sliceYaml(abs, anchor, milestone);
  if (file.endsWith(".json")) return sliceJson(abs, anchor);
  return sliceMarkdown(abs, anchor);
}

/**
 * Union of a backlog task's specs. Milestone filter per entry: its "(slice --milestone Mx)" suffix, else `milestone`,
 * else the task's own milestone; `milestone: false` disables filtering of entries without the suffix.
 */
export function sliceTask(taskId, { milestone = null, root = ROOT } = {}) {
  const backlog = parseYamlFiles([join(root, "specs/backlog.yaml")])[join(root, "specs/backlog.yaml")];
  if (!backlog || "error" in backlog) throw new Error(`backlog.yaml не разбирается: ${backlog?.error}`);
  const task = backlog.ok.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`задача не найдена: ${taskId}`);
  const parts = [];
  const files = new Set();
  for (const entry of task.specs) {
    const { path, anchor } = parseSpecRef(entry);
    const ms = /--milestone (M\d+)/.exec(String(entry))?.[1] ?? (milestone === false ? null : (milestone ?? task.milestone));
    files.add(path);
    const head = `${path}${anchor ? `#${anchor}` : ""}${ms ? ` (milestone ≤ ${ms})` : ""}`;
    parts.push(`# ==== ${head} ====\n${sliceFile(path, { anchor, milestone: ms, root })}`);
  }
  return { text: parts.join("\n"), files: [...files] };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v ?? null;
  };
  const all = argv.includes("--all") && argv.splice(argv.indexOf("--all"), 1).length > 0;
  const milestone = opt("--milestone");
  const task = opt("--task");
  try {
    if (task) process.stdout.write(sliceTask(task, { milestone: all ? false : milestone }).text);
    else if (argv.length === 1) {
      const { path, anchor } = parseSpecRef(argv[0]);
      process.stdout.write(sliceFile(path, { anchor, milestone }));
    } else {
      console.error("Использование: node tools/specs/slice.mjs <file>[#a.b] [--milestone M0] | --task <id> [--milestone M0 | --all]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`slice: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
