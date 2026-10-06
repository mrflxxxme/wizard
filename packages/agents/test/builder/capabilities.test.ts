// M2-40: capability cards with the class recipes, the full ui-kit documentation in builder.json (new components picked
// up from specs/ui/ui-kit.yaml automatically), shared text rules and report_capability_gap in the builder prompt.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  builderTools,
  CAPABILITY_IDS,
  capabilityDoc,
  STATIC_PROMPT,
  type ToolEnv,
  UI_KIT_COMPONENTS,
  uiKitDocs,
} from "../../src/builder/index.js";
import { textRules } from "../../src/text-rules.js";
import { REPO } from "../builder-helpers.js";
import { loadYaml } from "../helpers.js";

type Gen = {
  uiKitDocs(kit: unknown): { toc: string; components: Record<string, string> };
  capabilityCards(dir?: string): Record<string, { title: string; summary: string; body: string }>;
};
const gen = (await import(`${REPO}packages/agents/scripts/gen-builder-assets.mjs`)) as Gen;
const kit = loadYaml("specs/ui/ui-kit.yaml") as { components: { name: string; milestone?: string }[] };

describe("ui-kit docs in builder.json", () => {
  test("every ui-kit.yaml component up to the release (M2) is documented, FileField included", () => {
    const due = kit.components
      .filter((c) => ["M0", "M1", "M2"].includes(String(c.milestone ?? "M0").slice(0, 2)))
      .map((c) => c.name);
    expect([...UI_KIT_COMPONENTS].sort()).toEqual([...due].sort());
    expect(UI_KIT_COMPONENTS).toContain("FileField");
    expect(uiKitDocs(["FileField"]).docs).toContain("## FileField");
    expect(uiKitDocs().docs).toContain("- FileField:");
  });

  test("documented components are exported by @wizard/ui-kit", () => {
    const src = readdirSync(`${REPO}packages/ui-kit/src`, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(`${REPO}packages/ui-kit/src/${f}`, "utf8"))
      .join("\n");
    for (const name of UI_KIT_COMPONENTS) expect(src, name).toMatch(new RegExp(`export[^;]*\\b${name}\\b`));
  });

  test("the generator picks up new components (blocks, Image) and themes from the ui-kit source automatically", () => {
    const next = {
      ...kit,
      components: [
        ...kit.components,
        { name: "Hero", milestone: "M2P", props: "interface HeroProps {}", behaviour: ["Первый экран"] },
        {
          name: "Image",
          milestone: "M2",
          props: "interface ImageProps {}",
          behaviour: ["Картинка владельца"],
        },
        { name: "Later", milestone: "M3", behaviour: ["после выпуска"] },
      ],
      themes: [{ id: "calm", label: "Спокойная" }],
    };
    const out = gen.uiKitDocs(next);
    expect(Object.keys(out.components)).toEqual(expect.arrayContaining(["Hero", "Image", "FileField"]));
    expect(Object.keys(out.components)).not.toContain("Later");
    expect(out.toc).toContain("- Hero: Первый экран");
    expect(out.toc).toContain("- calm: Спокойная");
  });
});

describe("capability cards", () => {
  test("recipes of the three release classes and the general one; site builds the landing from ui-kit blocks", () => {
    expect(CAPABILITY_IDS).toEqual(expect.arrayContaining(["site", "booking", "crm", "general"]));
    const site = capabilityDoc("site");
    if (!("doc" in site)) throw new Error("no site card");
    for (const block of ["Header", "Hero", "Features", "Steps", "Faq", "Cta", "LeadForm", "Footer", "Image"])
      expect(site.doc).toContain(block);
    expect(capabilityDoc("nope")).toMatchObject({ unknown: "nope" });
  });

  test("a new card file shows up in the TOC without code changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-cards-"));
    try {
      writeFileSync(join(dir, "site.md"), "# Сайт\n> кратко\n\nтело");
      writeFileSync(join(dir, "quiz.md"), "# Опрос\n> анкета с итогом\n\nтело");
      expect(Object.keys(gen.capabilityCards(dir))).toEqual(["quiz", "site"]);
      writeFileSync(join(dir, "bad.md"), "без заголовка");
      expect(() => gen.capabilityCards(dir)).toThrow(/первая строка/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const id of CAPABILITY_IDS) expect(STATIC_PROMPT).toContain(`- ${id}: `);
  });
});

describe("builder prompt and tools", () => {
  test("static prompt: shared text rules for system texts, honest limits; ≤ 12k tokens", () => {
    for (const r of textRules("system")) expect(STATIC_PROMPT).toContain(r);
    expect(STATIC_PROMPT).toContain("report_capability_gap");
    expect(STATIC_PROMPT.length / 3.2).toBeLessThanOrEqual(12_000);
  });

  test("get_capability and report_capability_gap are declared with zod schemas", async () => {
    const tools = builderTools({} as ToolEnv);
    const cap = tools.find((t) => t.name === "get_capability");
    const gap = tools.find((t) => t.name === "report_capability_gap");
    expect(cap?.definition.parameters).toMatchObject({ type: "object", required: ["id"] });
    expect(gap?.definition.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["category", "quote", "missing", "offered"]),
    });
    expect(gap?.parse({ category: "sms", quote: "x", missing: "y", offered: null }).ok).toBe(false);
    // No host method: nothing is recorded, the model still gets an answer.
    const res = await gap?.run?.(
      { category: "messaging", quote: "SMS клиентам", missing: "SMS", offered: "письма" },
      { id: "c1", name: "report_capability_gap", args: {} },
    );
    expect(res).toMatchObject({ ok: true, recorded: false });
  });
});

describe("the notify card: its example passes the spec and connector checks", () => {
  test("the JSON ops of notify.md apply to the lead spec and leave no integration issues", async () => {
    const { applyOps } = await import("@wizard/appspec");
    const { validateIntegrations } = await import("@wizard/connectors");
    const { leadSpec } = await import("./lead-fixture.js");
    const md = (await import("node:fs")).readFileSync(
      new URL("../../assets/capabilities/notify.md", import.meta.url),
      "utf8",
    );
    const json = /```json\n([\s\S]*?)\n```/.exec(md)?.[1];
    expect(json).toBeDefined();
    const r = applyOps(leadSpec(), JSON.parse(json as string), 0);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(validateIntegrations(r.spec)).toEqual([]);
  });
});
