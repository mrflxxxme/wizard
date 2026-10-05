#!/usr/bin/env node
// Generates packages/agents/assets/builder.json — the builder's docs and prompt fragments cut from the specs
// (builder.yaml#tools.get_ui_kit_docs/get_sdk_docs: one source of documentation, sliced at build time).
// Capability cards (recipes of system classes, builder.yaml#capabilities) are packages/agents/assets/capabilities/*.md:
// one card per file, a new file shows up in the builder's prompt TOC after regeneration, without code changes.
// Usage: node packages/agents/scripts/gen-builder-assets.mjs [--check]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const ASSET_PATH = join(ROOT, "packages/agents/assets/builder.json");
export const CAPABILITIES_DIR = join(ROOT, "packages/agents/assets/capabilities");
const MILESTONES = ["M0", "M1", "M2", "M3", "M4"];
/**
 * Components and docs up to this milestone go into the asset: everything ui-kit has for the release (M2P counts as M2).
 * New ui-kit components (landing blocks, Image, ...) are picked up from specs/ui/ui-kit.yaml automatically.
 */
const MILESTONE = "M2";

const PY_YAML =
  "import sys, json, yaml\nprint(json.dumps([yaml.safe_load(open(p, encoding='utf-8')) for p in sys.argv[1:]]))";

function loadYaml(...paths) {
  const r = spawnSync(process.env.PYTHON || "python3", ["-c", PY_YAML, ...paths], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`YAML (python3 + PyYAML): ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

const upTo = (m) => {
  const i = MILESTONES.indexOf(String(m ?? "M0").slice(0, 2));
  return i >= 0 && i <= MILESTONES.indexOf(MILESTONE);
};

const oneLine = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Themes of ui-kit.yaml (themes or tokens.themes: list of {id|name, label?, description?} or a map id → text). */
function themesText(kit) {
  const t = kit.themes ?? kit.tokens?.themes;
  if (!t) return [];
  const items = Array.isArray(t)
    ? t.map((x) =>
        typeof x === "object" && x !== null
          ? `${x.id ?? x.name}${x.label || x.description || x.niche ? `: ${oneLine(x.label ?? x.description ?? x.niche)}` : ""}`
          : oneLine(x),
      )
    : Object.entries(t).map(([k, v]) =>
        typeof v === "object" && v !== null
          ? `${k}${v.label || v.description || v.niche ? `: ${oneLine(v.label ?? v.description ?? v.niche)}` : ""}`
          : `${k}: ${oneLine(v)}`,
      );
  return ["Темы (set_theme):", ...items.map((x) => `- ${x.length > 120 ? `${x.slice(0, 119)}…` : x}`)];
}

export function uiKitDocs(kit) {
  const components = {};
  const toc = [];
  const all = [...(kit.components ?? []), ...(Array.isArray(kit.blocks) ? kit.blocks : [])];
  for (const c of all.filter((c) => upTo(c.milestone))) {
    const behaviour = (c.behaviour ?? []).map((b) => `- ${b}`).join("\n");
    components[c.name] = [`## ${c.name}`, c.props?.trim() ?? "", behaviour].filter(Boolean).join("\n");
    const first = String(c.behaviour?.[0] ?? "").replace(/\s+/g, " ");
    toc.push(`- ${c.name}: ${first.length > 90 ? `${first.slice(0, 89)}…` : first}`);
  }
  const rules = (kit.rules ?? []).filter((r) => !r.startsWith("SHOULD: предложить")).map((r) => `- ${r}`);
  const tocText = [
    "# @wizard/ui-kit",
    "Компоненты (get_ui_kit_docs({components: [...]}) — пропсы и поведение):",
    ...toc,
    "Общие пропсы:",
    String(kit.common_props ?? "").trim(),
    "Правила:",
    ...rules,
    `Токены: var(--w-*); тема — ${kit.tokens?.source ?? "AppSpec.theme"}`,
    ...themesText(kit),
  ].join("\n");
  return { toc: tocText, components };
}

/** sdk.md split by numbered headings; topics map to sections (builder.yaml#tools.get_sdk_docs.input). */
function sdkDocs(md) {
  const sections = new Map();
  let cur = null;
  for (const line of md.split("\n")) {
    const m = /^(#{2,3}) (\d+(?:\.\d+)?)\.? /.exec(line);
    if (m) {
      cur = m[2];
      sections.set(cur, []);
    }
    if (cur) sections.get(cur).push(line);
  }
  const get = (...ids) =>
    ids
      .map((id) => {
        const s = sections.get(id);
        if (!s) throw new Error(`sdk.md: нет раздела ${id}`);
        return s.join("\n").trim();
      })
      .join("\n\n");
  const topics = {
    query: get("2.1", "2.2"),
    mutation: get("2.1", "2.2"),
    action: get("2.1", "2.5"),
    db: get("2.3", "2.4"),
    hooks: get("3"),
    connectors: get("2.5"),
    errors: get("2.5"),
    limits: get("2.1"),
  };
  const toc = [
    "# @wizard/sdk (get_sdk_docs({topic}) — фрагмент)",
    "Темы: query, mutation, action, db, hooks, connectors, errors, limits.",
    ...md
      .split("\n")
      .filter((l) => /^#{2,3} \d/.test(l))
      .map((l) => l.replace(/^#+ /, "- ")),
  ].join("\n");
  return { toc, topics };
}

function promptParts(builder, ops, gates) {
  const conv = builder.code_conventions;
  const conventions = [
    "Импорты:",
    ...conv.imports.map((s) => `- ${s}`),
    `Запрещённые API (G0-SEC-01): общие — ${gates.G0.forbidden_api.both}; functions/** — ${gates.G0.forbidden_api.functions}; ui/** — ${gates.G0.forbidden_api.ui}; лимиты — ${gates.G0.forbidden_api.limits}`,
    "Функции:",
    ...conv.functions.map((s) => `- ${s}`),
    "Интерфейс:",
    ...conv.ui.map((s) => `- ${s}`),
  ].join("\n");
  const opsText = Object.entries(ops.ops)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const semantic = ops.semantic_rules.map((s) => `- ${s}`).join("\n");
  const phases = builder.loop.phases.map((p) => `- ${p.id}: ${p.do}`).join("\n");
  return { conventions, ops: opsText, semantic, phases };
}

/**
 * Capability cards: "# Title" on the first line, "> summary" on the second, the rest is the body. Sorted by file name;
 * the id is the file name without .md.
 */
export function capabilityCards(dir = CAPABILITIES_DIR) {
  const cards = {};
  if (!existsSync(dir)) return cards;
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".md"))
    .sort()) {
    const id = f.slice(0, -3);
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error(`${f}: имя карточки — латиница в нижнем регистре`);
    const lines = readFileSync(join(dir, f), "utf8").replace(/\r/g, "").split("\n");
    const title = /^# (.+)$/.exec(lines[0] ?? "")?.[1]?.trim();
    const summary = /^> (.+)$/.exec(lines[1] ?? "")?.[1]?.trim();
    if (!title || !summary) throw new Error(`${f}: первая строка «# Заголовок», вторая «> кратко»`);
    cards[id] = { title, summary, body: lines.join("\n").trim() };
  }
  return cards;
}

export function buildAssets() {
  const [builder, ops, gates, kit] = loadYaml(
    join(ROOT, "specs/agents/builder.yaml"),
    join(ROOT, "specs/appspec/ops.yaml"),
    join(ROOT, "specs/quality/gates.yaml"),
    join(ROOT, "specs/ui/ui-kit.yaml"),
  );
  const md = readFileSync(join(ROOT, "specs/runtime/sdk.md"), "utf8");
  const assets = {
    note: "Generated by packages/agents/scripts/gen-builder-assets.mjs from specs/ — do not edit.",
    milestone: MILESTONE,
    uiKit: uiKitDocs(kit),
    sdk: sdkDocs(md),
    prompt: promptParts(builder, ops, gates),
    capabilities: capabilityCards(),
  };
  return `${JSON.stringify(assets, null, 1)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = buildAssets();
  if (process.argv.includes("--check")) {
    // Compared as data: biome may reformat the committed JSON.
    const same =
      existsSync(ASSET_PATH) &&
      JSON.stringify(JSON.parse(readFileSync(ASSET_PATH, "utf8"))) === JSON.stringify(JSON.parse(text));
    if (!same) {
      console.error(`${ASSET_PATH} устарел: запустите node packages/agents/scripts/gen-builder-assets.mjs`);
      process.exit(1);
    }
    console.log(`${ASSET_PATH}: актуален`);
  } else {
    writeFileSync(ASSET_PATH, text);
    console.log(`${ASSET_PATH}: ${text.length} символов`);
  }
}
