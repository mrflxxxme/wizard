#!/usr/bin/env node
// Проверка целостности specs/ (см. specs/README.md). Node 22, без зависимостей.
// YAML разбирается через python3 + PyYAML (одним вызовом на все файлы).
// Запуск: node tools/specs/validate.mjs [--root=<repo>] [--quiet]
// Код выхода: 0 — ошибок нет (предупреждения допустимы), 1 — есть ошибки.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------- YAML via python ----------------
const PY_LOADER = `
import sys, json
try:
    import yaml
except ImportError:
    print(json.dumps({"__fatal__": "PyYAML не установлен"})); sys.exit(0)
class L(yaml.SafeLoader): pass
def cm(loader, node, deep=False):
    loader.flatten_mapping(node)
    seen = set()
    for k, _ in node.value:
        key = loader.construct_object(k, deep=deep)
        try:
            if key in seen:
                raise yaml.constructor.ConstructorError(None, None, "duplicate key %r" % (key,), k.start_mark)
            seen.add(key)
        except TypeError:
            pass
    return yaml.SafeLoader.construct_mapping(loader, node, deep)
L.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, cm)
out = {}
for p in sys.argv[1:]:
    try:
        with open(p, encoding="utf-8") as f:
            out[p] = {"ok": yaml.load(f, Loader=L)}
    except Exception as e:
        out[p] = {"error": str(e).replace("\\n", " ")}
print(json.dumps(out, default=str))
`;

export function parseYamlFiles(paths) {
  if (paths.length === 0) return {};
  const py = process.env.PYTHON || "python3";
  const r = spawnSync(py, ["-c", PY_LOADER, ...paths], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const hint = "Нужны python3 и PyYAML: `apt install python3-yaml` или `python3 -m pip install pyyaml` (или PYTHON=<путь>).";
  if (r.error) throw new Error(`Не удалось запустить ${py}: ${r.error.message}. ${hint}`);
  if (r.status !== 0) throw new Error(`${py} завершился с кодом ${r.status}: ${r.stderr.trim()}. ${hint}`);
  const out = JSON.parse(r.stdout);
  if (out.__fatal__) throw new Error(`${out.__fatal__}. ${hint}`);
  return out;
}

// ---------------- Minimal JSON Schema (draft 2020-12 subset) ----------------
const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description", "default", "examples", "format", "deprecated", "readOnly", "writeOnly"]);
const SUPPORTED = new Set(["$ref", "type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "pattern", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "allOf", "anyOf", "oneOf", "not"]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const typeMatches = (t, v) => { const a = typeOf(v); return t === "number" ? a === "number" || a === "integer" : a === t; };
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const ptr = (p) => p || "/";

function resolveRef(root, ref) {
  if (!ref.startsWith("#")) throw new Error(`внешние $ref не поддерживаются: ${ref}`);
  let node = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || !(key in node)) throw new Error(`$ref не найден: ${ref}`);
    node = node[key];
  }
  return node;
}

/** Validates data against schema; returns [{path, message}]. `unsupported` collects unknown keywords. */
export function validateSchema(schema, data, root = schema, path = "", errors = [], unsupported = new Set()) {
  if (schema === true || schema === undefined) return errors;
  if (schema === false) { errors.push({ path: ptr(path), message: "значение запрещено схемой" }); return errors; }
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k)) unsupported.add(k);
  const err = (message) => errors.push({ path: ptr(path), message });

  if (schema.$ref) validateSchema(resolveRef(root, schema.$ref), data, root, path, errors, unsupported);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, data))) { err(`ожидался тип ${types.join("|")}, получен ${typeOf(data)}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => canon(e) === canon(data))) err(`значение ${JSON.stringify(data)} не из enum [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`);
  if ("const" in schema && canon(schema.const) !== canon(data)) err(`ожидалось ${JSON.stringify(schema.const)}`);

  const t = typeOf(data);
  if (t === "string") {
    const len = [...data].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`длина ${len} < minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`длина ${len} > maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(data)) err(`строка ${JSON.stringify(data)} не соответствует ${schema.pattern}`);
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum !== undefined && data < schema.minimum) err(`${data} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) err(`${data} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) err(`${data} ≤ exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) err(`${data} ≥ exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  if (t === "array") {
    if (schema.minItems !== undefined && data.length < schema.minItems) err(`элементов ${data.length} < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) err(`элементов ${data.length} > maxItems ${schema.maxItems}`);
    if (schema.uniqueItems && new Set(data.map(canon)).size !== data.length) err("элементы не уникальны (uniqueItems)");
    if (schema.items !== undefined) data.forEach((v, i) => validateSchema(schema.items, v, root, `${path}/${i}`, errors, unsupported));
  }
  if (t === "object") {
    for (const r of schema.required ?? []) if (!(r in data)) err(`нет обязательного свойства "${r}"`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(data)) {
      const p = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (k in props) validateSchema(props[k], v, root, p, errors, unsupported);
      else if (schema.additionalProperties === false) errors.push({ path: ptr(p), message: `лишнее свойство "${k}" (additionalProperties: false)` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(schema.additionalProperties, v, root, p, errors, unsupported);
    }
  }
  const sub = (s) => validateSchema(s, data, root, path, [], unsupported).length === 0;
  if (schema.allOf) for (const s of schema.allOf) validateSchema(s, data, root, path, errors, unsupported);
  if (schema.anyOf && !schema.anyOf.some(sub)) err("не подходит ни под одну схему anyOf");
  if (schema.oneOf && schema.oneOf.filter(sub).length !== 1) err("должно подходить ровно под одну схему oneOf");
  if (schema.not && sub(schema.not)) err("подходит под схему not");
  return errors;
}

function collectRefs(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) (k === "$ref" && typeof v === "string" ? out.push(v) : collectRefs(v, out));
  return out;
}

// ---------------- Checks ----------------
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function runChecks(root) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);
  const rel = (p) => relative(root, p);
  const specsDir = join(root, "specs");
  const stats = { files: 0, tasks: 0, examples: 0 };

  // 1. Parse everything under specs/
  const files = walk(specsDir);
  const yamlFiles = files.filter((f) => /\.ya?ml$/.test(f));
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const docs = {};
  let parsed;
  try { parsed = parseYamlFiles(yamlFiles); } catch (e) { return { errors: [e.message], warnings, stats, fatal: true }; }
  for (const f of yamlFiles) {
    const r = parsed[f];
    if (!r || "error" in r) E(`${rel(f)}: YAML не разбирается: ${r?.error ?? "нет результата"}`);
    else docs[rel(f)] = r.ok;
  }
  for (const f of jsonFiles) {
    try { docs[rel(f)] = JSON.parse(readFileSync(f, "utf8")); } catch (e) { E(`${rel(f)}: JSON не разбирается: ${e.message}`); }
  }
  stats.files = yamlFiles.length + jsonFiles.length;

  const pathExists = (p) => existsSync(join(root, String(p).split("#")[0]));

  // 2. Milestones
  const milestones = docs["specs/milestones.yaml"]?.milestones;
  const msOrder = new Map();
  if (!Array.isArray(milestones)) E("specs/milestones.yaml: нет списка milestones");
  else milestones.forEach((m, i) => { if (msOrder.has(m.id)) E(`milestones: дубликат id ${m.id}`); msOrder.set(m.id, i); });

  // 3. Backlog graph
  const tasks = docs["specs/backlog.yaml"]?.tasks;
  const missingSpecs = new Map(); // path -> [taskIds]
  if (!Array.isArray(tasks)) E("specs/backlog.yaml: нет списка tasks");
  else {
    stats.tasks = tasks.length;
    const byId = new Map();
    for (const t of tasks) {
      const id = t?.id ?? "<без id>";
      for (const k of ["id", "title", "milestone", "deps", "specs", "acceptance"]) if (t?.[k] === undefined) E(`backlog ${id}: нет поля ${k}`);
      if (typeof t?.id === "string" && !/^M\d-\d{2}$/.test(t.id)) E(`backlog ${id}: id не по формату M<n>-<nn>`);
      if (byId.has(id)) E(`backlog: дубликат id ${id}`);
      byId.set(id, t);
      if (msOrder.size && !msOrder.has(t?.milestone)) E(`backlog ${id}: неизвестная веха ${t?.milestone}`);
      if (!Array.isArray(t?.acceptance) || t.acceptance.length === 0) E(`backlog ${id}: пустой acceptance`);
      for (const s of Array.isArray(t?.specs) ? t.specs : []) {
        if (!pathExists(s)) missingSpecs.set(s, [...(missingSpecs.get(s) ?? []), id]);
      }
    }
    for (const t of tasks) {
      for (const d of Array.isArray(t?.deps) ? t.deps : []) {
        const dep = byId.get(d);
        if (!dep) { E(`backlog ${t.id}: зависимость ${d} не существует`); continue; }
        if (msOrder.has(dep.milestone) && msOrder.has(t.milestone) && msOrder.get(dep.milestone) > msOrder.get(t.milestone))
          E(`backlog ${t.id} (${t.milestone}) зависит от более поздней вехи: ${d} (${dep.milestone})`);
      }
    }
    // cycles (iterative-safe DFS with colors)
    const color = new Map();
    const stack = [];
    const visit = (id) => {
      color.set(id, 1); stack.push(id);
      for (const d of byId.get(id)?.deps ?? []) {
        if (!byId.has(d)) continue;
        if (color.get(d) === 1) { E(`backlog: цикл зависимостей ${[...stack.slice(stack.indexOf(d)), d].join(" → ")}`); continue; }
        if (!color.get(d)) visit(d);
      }
      color.set(id, 2); stack.pop();
    };
    for (const id of byId.keys()) if (!color.get(id)) visit(id);
  }
  for (const [p, ids] of [...missingSpecs].sort()) W(`backlog: спека ещё не написана: ${p} (задачи: ${ids.join(", ")})`);

  // 4. Architecture
  const arch = docs["specs/architecture.yaml"];
  if (!arch?.monorepo) E("specs/architecture.yaml: нет monorepo");
  else {
    const units = [...(arch.monorepo.packages ?? []), ...(arch.monorepo.apps ?? [])];
    const ids = new Set(units.map((u) => u.id));
    for (const u of units) {
      if (u.spec && !pathExists(u.spec)) W(`architecture ${u.id}: спека не найдена: ${u.spec}`);
      for (const d of u.depends_on ?? []) if (!ids.has(d)) E(`architecture ${u.id}: depends_on неизвестного пакета ${d}`);
    }
  }

  // 5. AppSpec schema + examples
  const schemaPath = "specs/appspec/appspec.schema.json";
  const schema = docs[schemaPath];
  if (!schema) E(`${schemaPath}: нет схемы`);
  else {
    for (const ref of collectRefs(schema)) {
      try { resolveRef(schema, ref); } catch (e) { E(`${schemaPath}: ${e.message}`); }
    }
    const exDir = join(specsDir, "appspec", "examples");
    const examples = walk(exDir).filter((f) => f.endsWith(".json"));
    stats.examples = examples.length;
    const unsupported = new Set();
    for (const f of examples) {
      const data = docs[rel(f)];
      if (data === undefined) continue; // parse error already reported
      const errs = validateSchema(schema, data, schema, "", [], unsupported);
      for (const e of errs.slice(0, 20)) E(`${rel(f)}: ${e.path}: ${e.message}`);
      if (errs.length > 20) E(`${rel(f)}: … ещё ${errs.length - 20} ошибок`);
    }
    if (unsupported.size) W(`валидатор схемы не поддерживает ключевые слова: ${[...unsupported].join(", ")} (проверка неполная)`);
  }

  return { errors, warnings, stats };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
  const root = resolve(typeof args.root === "string" ? args.root : join(HERE, "..", ".."));
  const { errors, warnings, stats, fatal } = runChecks(root);
  if (fatal) { console.error(`specs-validate: FATAL\n  ${errors.join("\n  ")}`); process.exit(1); }
  console.log(`specs-validate: файлов ${stats.files}, задач ${stats.tasks}, примеров AppSpec ${stats.examples}`);
  if (warnings.length && !args.quiet) console.log(`WARN (${warnings.length}):\n  ${warnings.join("\n  ")}`);
  if (errors.length) { console.error(`ERROR (${errors.length}):\n  ${errors.join("\n  ")}`); process.exit(1); }
  console.log(`OK (ошибок 0, предупреждений ${warnings.length})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
