// V3-06 (node): the layered layout of the brief diagrams — no node overlaps a node, no label overlaps a node or a label,
// every line fits its box, the width of the container is kept on typical briefs (390 px phones included), any graph
// (empty, cyclic, broken, 60 scenarios, random) lays out; the theses of the short brief; the highlight keys match
// briefDiff; brief CSS animates only transform/opacity.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_LIMITS,
  type BriefGraph,
  briefDiagrams,
  briefDiff,
  type SystemBrief,
  systemBriefSchema,
} from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { dentalBrief, minimalBrief, scenario, shopBrief } from "../../appspec/test/brief-fixtures.js";
import {
  archetypeName,
  briefTheses,
  changedKeys,
  type GraphLayout,
  itemKey,
  BRIEF_LAYOUT as L,
  layoutBriefGraph,
  overlaps,
  textWidth,
  wrapText,
} from "../src/v2/index.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";

const parse = (b: unknown): SystemBrief => systemBriefSchema.parse(b);
const BRIEFS = { dental: parse(dentalBrief()), shop: parse(shopBrief()), minimal: parse(minimalBrief()) };
/** Inner widths: a 390 px phone panel, the desktop panel, the wide demo. */
const WIDTHS = [326, 358, 520, 760, 1100];

function problems(l: GraphLayout): string[] {
  const out: string[] = [];
  const labels = l.edges
    .filter((e) => e.lw > 0)
    .map((e) => ({ id: `label ${e.from}>${e.to}`, x: e.lx, y: e.ly, w: e.lw, h: e.lh }));
  for (const [a, b] of overlaps([...l.nodes, ...labels])) out.push(`overlap ${a} / ${b}`);
  for (const n of l.nodes) {
    if (n.x < 0 || n.y < 0 || n.x + n.w > l.width + 0.5 || n.y + n.h > l.height + 0.5)
      out.push(`outside ${n.id}`);
    if (n.lines.length > L.nodeMaxLines) out.push(`too many lines ${n.id}`);
    for (const line of n.lines)
      if (textWidth(line, L.nodeFont) > n.w - 2 * L.nodePadX + 0.5)
        out.push(`line wider than ${n.id}: ${line}`);
  }
  for (const b of labels)
    if (b.x < 0 || b.x + b.w > l.width + 0.5 || b.y + b.h > l.height + 0.5) out.push(`outside ${b.id}`);
  for (const e of l.edges)
    if (!/^M[\d.]+ [\d.]+/.test(e.d) || /NaN|Infinity/.test(e.d)) out.push(`path ${e.d}`);
  return out;
}

/** Seeded PRNG (mulberry32) for random graphs. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  "Клиент",
  "оставляет",
  "заявку",
  "система",
  "уведомляет",
  "менеджера",
  "Щедрый",
  "ЖМЫХ",
  "Telegram",
];

function randomGraph(seed: number): BriefGraph {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 24);
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    label: Array.from({ length: 1 + Math.floor(r() * 16) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(
      " ",
    ),
    kind: (["actor", "scenario", "goal", "entity", "entity_pii", "role", "integration", "system"] as const)[
      Math.floor(r() * 8)
    ] as BriefGraph["nodes"][number]["kind"],
  }));
  const edges = Array.from({ length: Math.floor(r() * n * 1.6) }, () => ({
    from: `n${Math.floor(r() * n)}`,
    to: `n${Math.floor(r() * n)}`,
    label: r() < 0.7 ? WORDS.slice(0, 1 + Math.floor(r() * 4)).join(" ") : "",
  }));
  return { nodes, edges };
}

describe("layoutBriefGraph", () => {
  for (const [name, brief] of Object.entries(BRIEFS))
    test(`${name}: three diagrams at ${WIDTHS.join("/")} px — no overlaps, lines fit, width kept`, () => {
      const d = briefDiagrams(brief);
      for (const [key, graph] of Object.entries(d) as [string, BriefGraph][])
        for (const width of WIDTHS) {
          const l = layoutBriefGraph(graph, { width });
          expect(problems(l), `${key} @${width}`).toEqual([]);
          expect(l.width, `${key} @${width}`).toBe(width);
          expect(l.nodes.map((x) => x.id).sort()).toEqual(graph.nodes.map((x) => x.id).sort());
          expect(l.edges).toHaveLength(graph.edges.length);
          // Every node keeps its whole label (typical briefs never hit the line limit).
          for (const x of l.nodes) expect(x.lines.join(" ")).toBe(x.label.replace(/\s+/g, " ").trim());
        }
    });

  test("overlaps finds crossing boxes and ignores touching ones", () => {
    const a = { id: "a", x: 0, y: 0, w: 10, h: 10 };
    expect(overlaps([a, { id: "b", x: 5, y: 5, w: 10, h: 10 }])).toEqual([["a", "b"]]);
    expect(overlaps([a, { id: "c", x: 10, y: 0, w: 10, h: 10 }])).toEqual([]);
  });

  test("the same graph always gives the same layout", () => {
    const g = briefDiagrams(BRIEFS.dental).journey;
    expect(layoutBriefGraph(g, { width: 358 })).toEqual(layoutBriefGraph(structuredClone(g), { width: 358 }));
  });

  test("empty, cyclic, broken and duplicate graphs lay out without overlaps", () => {
    const cases: BriefGraph[] = [
      { nodes: [], edges: [] },
      {
        nodes: [
          { id: "a", label: "А", kind: "scenario" },
          { id: "b", label: "Б", kind: "scenario" },
          { id: "c", label: "В", kind: "scenario" },
        ],
        edges: [
          { from: "a", to: "b", label: "затем" },
          { from: "b", to: "c", label: "затем" },
          { from: "c", to: "a", label: "снова" },
          { from: "b", to: "a", label: "назад" },
          { from: "a", to: "a", label: "сам" },
          { from: "a", to: "zz", label: "нет" },
        ],
      },
      {
        nodes: [
          { id: "x", label: "Узел", kind: "role" },
          { id: "x", label: "Повтор", kind: "role" },
        ],
        edges: [],
      },
    ];
    for (const g of cases) {
      const l = layoutBriefGraph(g, { width: 358 });
      expect(problems(l)).toEqual([]);
    }
    const cyc = layoutBriefGraph(cases[1] as BriefGraph, { width: 358 });
    expect(cyc.edges.some((e) => e.reversed)).toBe(true);
    expect(cyc.edges.map((e) => `${e.from}>${e.to}`)).not.toContain("a>a");
  });

  test("a brief at the limits (60 scenarios, 20 roles, 40 entities) lays out on a phone without overlaps", () => {
    const big = parse({
      goals: Array.from({ length: BRIEF_LIMITS.goals }, (_, i) => ({
        id: `g${i}`,
        text: `Цель номер ${i + 1} с длинным пояснением для проверки переноса`,
        success: "Растёт",
      })),
      scenarios: Array.from({ length: BRIEF_LIMITS.scenarios }, (_, i) =>
        scenario(
          {
            id: `s${i}`,
            actor: (["visitor", "client", "staff", "owner", "system"] as const)[i % 5] ?? "visitor",
            when: `событие ${i + 1} происходит в системе и ждёт ответа`,
            goalId: `g${i % BRIEF_LIMITS.goals}`,
          },
          ["делает шаг", "уведомляет ответственного сотрудника"],
        ),
      ),
      roles: Array.from({ length: BRIEF_LIMITS.roles }, (_, i) => ({
        id: `r${i}`,
        name: `Роль ${i + 1}`,
        can: ["видит заявки", "полный доступ"],
      })),
      data: Array.from({ length: BRIEF_LIMITS.data }, (_, i) => ({
        entity: `Заявка ${i + 1}`,
        fields: [{ name: "Телефон", pii: true }],
        retention: "1 год",
      })),
    });
    for (const g of Object.values(briefDiagrams(big))) {
      const l = layoutBriefGraph(g, { width: 358 });
      expect(problems(l)).toEqual([]);
    }
  });

  test("random graphs (60 seeds × 2 widths) lay out without overlaps", () => {
    for (let seed = 1; seed <= 60; seed++)
      for (const width of [326, 760]) {
        const l = layoutBriefGraph(randomGraph(seed), { width });
        expect(problems(l), `seed ${seed} @${width}`).toEqual([]);
      }
  });

  test("wrapText keeps lines within the width, cuts a long word and ends an overflow with «…»", () => {
    const lines = wrapText(
      "Когда клиент оставляет заявку на сайте, система уведомляет менеджера",
      120,
      13,
      10,
    );
    for (const x of lines) expect(textWidth(x, 13)).toBeLessThanOrEqual(120);
    expect(lines.join(" ")).toBe("Когда клиент оставляет заявку на сайте, система уведомляет менеджера");
    const cut = wrapText("Щщщщщщщщщщщщщщщщщщщщщщщщщщщщ", 60, 13, 10);
    expect(cut.length).toBeGreaterThan(1);
    const capped = wrapText("слово ".repeat(80), 80, 13, 3);
    expect(capped).toHaveLength(3);
    expect(capped[2]?.endsWith("…")).toBe(true);
  });
});

describe("short brief and highlight", () => {
  test("typical briefs give 5–8 theses in plain words", () => {
    for (const b of [BRIEFS.dental, BRIEFS.shop]) {
      const t = briefTheses(b);
      expect(t.length).toBeGreaterThanOrEqual(5);
      expect(t.length).toBeLessThanOrEqual(8);
      for (const x of t) expect(x).toMatch(/[а-яё]/i);
    }
    expect(briefTheses(BRIEFS.dental)[0]).toContain("получать записи на приём с сайта");
    expect(briefTheses(BRIEFS.minimal)).toEqual([]);
  });

  test("the direction of the site (V3-09) is a thesis by its Russian name; an unknown archetype is not", () => {
    const shop = BRIEFS.shop;
    const pinned = briefTheses(
      parse({ ...shop, design: { archetype: "editorial", pinned: true, references: [] } }),
    );
    expect(pinned).toContain("Стиль сайта: «Редакционный» — выбран вами");
    const auto = briefTheses(parse({ ...shop, design: { archetype: "editorial", references: [] } }));
    expect(auto).toContain("Стиль сайта: «Редакционный» — подобран системой");
    expect(briefTheses(BRIEFS.dental).some((t) => t.startsWith("Стиль сайта"))).toBe(false);
    expect(archetypeName("editorial")).toBe("Редакционный");
    expect(archetypeName("warm_clinic")).toBe("warm_clinic");
  });

  test("changedKeys marks exactly the items briefDiff changed (keys as briefDiff matches them)", () => {
    const a = BRIEFS.dental;
    const b = parse({
      ...a,
      goals: [{ ...a.goals[0], success: "40 записей" }, a.goals[1]],
      data: [...a.data, { entity: "Отзыв", fields: [], retention: "1 год" }],
      outOfScope: [],
      audience: "Все",
    });
    const m = changedKeys(briefDiff(a, b));
    expect(m.items.get("goals")?.get(itemKey("goals", a.goals[0]))).toBe("changed");
    expect(m.items.get("goals")?.has(itemKey("goals", a.goals[1]))).toBe(false);
    expect(m.items.get("data")?.get(itemKey("data", { entity: "Отзыв" }))).toBe("added");
    expect(m.whole.has("audience")).toBe(true);
    // A removed item is not highlighted in the brief (it is not there); the diff view shows it.
    expect(m.items.get("outOfScope")).toBeUndefined();
  });
});

describe("brief CSS", () => {
  const DIR = join(UI_KIT_ROOT, "src/v2/components/brief");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));
  test("keyframes and transitions only on transform/opacity; no own glass", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    const bad: string[] = [];
    for (const f of files) {
      const css = readFileSync(join(DIR, f), "utf8");
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g))
        for (const d of (m[2] ?? "").matchAll(/([a-z-]+)\s*:/g))
          if (!["opacity", "transform"].includes(d[1] as string)) bad.push(`${f} @keyframes: ${d[1]}`);
      for (const m of css.matchAll(/transition:\s*([^;]+);/g))
        for (const part of (m[1] ?? "").split(/,(?![^(]*\))/))
          if (!["opacity", "transform"].includes(part.trim().split(/\s+/)[0] ?? ""))
            bad.push(`${f}: ${part}`);
      if (/backdrop-filter|transition-property/.test(css))
        bad.push(`${f}: backdrop-filter/transition-property`);
    }
    expect(bad).toEqual([]);
  });
});
