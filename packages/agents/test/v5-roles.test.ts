// V5-03 acceptance (D80 (6), grill-10 Р7, grill-11 (8)): the chain strategist → copywriter → editor → director →
// signature section (two candidates, a judge) → critic on slots, on scripted answers (no network, no money): every role
// runs and saves its record, the home page consists only of catalog blocks and one signature section, the build costs
// ≤ 500 ₽ in the report, the editor's anti-slop list is enforced, a role that fails leaves the v3 page.
import { emptySpec, systemBriefSchema } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { createRegistry, type LlmTool, type RouteInput, type RouteOutput } from "@wizard/llm";
import { BLOCKS, blocksOf, contentErrors, type SlotSpec } from "@wizard/ui-kit";
import { describe, expect, test } from "vitest";
import { runBuildV3, type V3BriefVersion, type V3Checkpoint, type V3Host } from "../src/builder/index.js";
import {
  concreteShare,
  homeSource,
  pageIssues,
  signatureSourceIssues,
  slopIssues,
} from "../src/builder/v4/index.js";
import { clinicBrief, fakeComposer } from "./v3-harness-fixtures.js";

const reg = createRegistry({ buildDefaultTier: "T1" });
const PHOTO = {
  src: "/_wizard/photos/0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a/1600",
  alt: "Мастер у подъёмника",
  credit: "Автор, pexels",
};

/** Phrases the editor must remove (grill-11 (8)); each one is caught by code, not by the model's good will. */
const SLOP = [
  "Мы заботимся о каждом клиенте",
  "Быстрый, надёжный, удобный сервис",
  "Не просто ремонт, а забота о машине",
  "Ремонт — быстро и качественно",
  "Команда профессионалов с индивидуальным подходом",
  "Добро пожаловать в наш автосервис",
  "Уникальный сервис по доступным ценам",
  "Погрузитесь в мир автомобилей",
  "Мы стремимся к совершенству",
  "Современный комплексный подход к ремонту",
];
const CLEAN = [
  "Ремонт за 3 часа, гарантия 12 месяцев",
  "Заменим масло за 40 минут: 1 900 ₽ с фильтром",
  "Принимаем с 8:00 до 21:00, без выходных",
];

describe("anti-slop of the editor", () => {
  test.each(SLOP)("«%s» is caught", (phrase) => {
    expect(slopIssues(phrase).length).toBeGreaterThan(0);
  });
  test.each(CLEAN)("«%s» passes", (phrase) => {
    expect(slopIssues(phrase)).toEqual([]);
  });
  test("a copy with figures is more concrete than one without", () => {
    expect(concreteShare({ a: "Ремонт за 3 часа, гарантия год" })).toBe(1);
    expect(concreteShare({ a: "Ремонт быстро и аккуратно у нас" })).toBe(0);
  });
});

/** A valid value for a slot, by its description. */
function fill(s: SlotSpec, n = 0): unknown {
  switch (s.kind) {
    case "text":
      return `Запись ${n + 2} дня, цена от ${1000 + n} ₽`.slice(0, s.max).padEnd(s.min ?? 1, "0");
    case "number":
      return 1500 + n;
    case "href":
      return "#booking";
    case "photo":
      return PHOTO;
    case "icon":
      return "wrench";
    case "mark":
      return undefined;
    case "list":
      return Array.from({ length: s.min }, (_, i) =>
        Object.keys(s.item).length === 1 && s.item[Object.keys(s.item)[0] as string]?.kind !== "group"
          ? fill(Object.values(s.item)[0] as SlotSpec, i)
          : Object.fromEntries(Object.entries(s.item).map(([k, v]) => [k, fill(v, i)])),
      );
    case "group":
      return Object.fromEntries(Object.entries(s.slots).map(([k, v]) => [k, fill(v, n)]));
  }
}
const fillBlock = (id: string) => {
  const spec = (BLOCKS.find((b) => b.spec.id === id) as (typeof BLOCKS)[number]).spec;
  return Object.fromEntries(
    Object.entries(spec.slots)
      .map(([k, v]) => [k, fill(v)] as const)
      .filter(([, v]) => v !== undefined),
  );
};

const DIRECTION = "nochnoy-produkt" as const;
const CATALOG = blocksOf(DIRECTION).map((b) => b.spec);
const pick = (section: string) => CATALOG.find((b) => b.section === section)?.id as string;
const PAGE_IDS = ["header", "hero", "prices", "steps", "booking", "reviews", "contacts", "footer"].map(pick);

const SIGNATURE = `import { useState } from "react";

export default function Status() {
  const [n, setN] = useState(1);
  return (
    <section className="bg-surface text-ink px-6 py-16">
      <h2 className="font-display text-3xl">Статус ремонта: этап {n} из 4</h2>
      <button type="button" className="bg-accent text-accent-ink mt-4 px-4 py-2" onClick={() => setN((x) => (x % 4) + 1)}>
        Следующий этап
      </button>
    </section>
  );
}
`;

const positioning = (sitemap: string[]) => ({
  name: "Ночной сервис",
  essence: "Автосервис в Екатеринбурге, работает с 8:00 до 23:00, ремонт за один день.",
  audience: "Водители, которым некогда ждать три дня.",
  usp: ["Ремонт за 1 день", "Гарантия 12 месяцев на работы"],
  proof: ["9 лет на рынке", "4,9 по 312 отзывам"],
  tone: "Деловой и короткий, без восклицаний",
  direction: DIRECTION,
  directionWhy: "Запись онлайн и статус ремонта, как в приложении.",
  sitemap: sitemap.map((id) => ({ id, purpose: `Раздел ${id}` })),
});
const SITEMAP = ["header", "hero", "prices", "steps", "booking", "reviews", "contacts", "footer"];
const copy = () => ({
  sections: SITEMAP.map((id) => ({
    id,
    headline: `Ремонт за 1 день, гарантия 12 месяцев (${id})`,
    items: [],
  })),
  assumptions: [],
});

interface Script {
  /** Replaces the answer of a callType. */
  answer?: Partial<Record<string, (input: RouteInput, n: number) => unknown>>;
}

const MODEL: Record<string, string> = {
  role_strategist: "glm-5.3",
  role_copywriter: "glm-5.3",
  role_editor: "deepseek-v4-pro-0813",
  role_director: "glm-5.3",
  signature_section: "glm-5.3",
  role_judge: "mimo-v2.6-pro",
  critic_visual: "glm-5v-turbo",
};

/** Scripted model: the answer of each role is the call of the tool it was offered; ₽ priced by a fixed credit. */
function scripted(o: Script = {}) {
  const calls: { callType: string; model: string; avoid: readonly string[] }[] = [];
  const counts = new Map<string, number>();
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    const n = counts.get(input.callType) ?? 0;
    counts.set(input.callType, n + 1);
    // The second candidate of the signature section is of another family when asked to avoid the first's.
    const model =
      input.callType === "signature_section" && input.avoidFamilies?.includes("glm")
        ? "kimi-k3"
        : (MODEL[input.callType] ?? "glm-5.3");
    calls.push({ callType: input.callType, model, avoid: input.avoidFamilies ?? [] });
    const tool = (input.tools as LlmTool[])[0] as LlmTool;
    const make: Record<string, () => unknown> = {
      role_strategist: () => positioning(SITEMAP),
      role_copywriter: copy,
      role_editor: () => ({ copy: copy(), changes: ["Убрал штамп в заголовке первого экрана"] }),
      role_director: () => ({
        direction: DIRECTION,
        blocks: PAGE_IDS.map((id) => ({ id, content: fillBlock(id) })),
      }),
      signature_section: () => ({
        title: n ? "Чат мастера" : "Статус ремонта",
        idea: "Этапы ремонта заполняются до текущего",
        after: pick("hero"),
        source: SIGNATURE,
      }),
      role_judge: () => ({ pick: "B", why: "Второй вариант ближе к ремонту" }),
      critic_visual: () => ({ score: 82, verdict: "Ритм ровный, правок нет", edits: [] }),
    };
    const args = (o.answer?.[input.callType] ?? make[input.callType])?.(input, n) ?? make[input.callType]?.();
    return {
      tier: "T1",
      model,
      result: { toolCalls: [{ id: `c${calls.length}`, name: tool.name, args }], finishReason: "tool_calls" },
      usage: { inputTokens: 6000, cachedTokens: 0, outputTokens: 2500 },
      creditsCharged: 3,
      creditsMilli: 3000,
      routeReason: "default_T1",
      scrubbed: false,
      ruFallback: false,
    };
  };
  return { route, calls };
}

const gates = (level: string, version: number): GateReport => ({
  level: level as GateReport["level"],
  passed: true,
  specVersion: version,
  startedAt: "2026-10-21T00:00:00.000Z",
  durationMs: 1,
  checks: [],
  summary: { pass: 1, fail: 0, warn: 0, skip: 0, error: 0 },
});

interface Sys {
  version: number;
  files: Record<string, string>;
  checkpoints: Map<string, V3Checkpoint>;
}

const roleCalls = (m: { calls: { callType: string }[] }) =>
  m.calls.map((c) => c.callType).filter((t) => t !== "page_compose");

async function buildFlagship(o: Script & { roles?: boolean; sys?: Sys } = {}) {
  const sys: Sys = o.sys ?? { version: 0, files: {}, checkpoints: new Map() };
  const brief: V3BriefVersion = { version: 1, brief: systemBriefSchema.parse(clinicBrief()) };
  const model = scripted(o);
  const clock = { t: 0 };
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const host: V3Host = {
    run: { id: "run-1" },
    systemId: "sys-flagship",
    runStep: (_n, fn) => fn(),
    emit: (type, payload) => {
      events.push({ type, payload });
    },
    route: async (input) => model.route(input as RouteInput),
    brief: async () => brief,
    checkpoints: {
      load: async () => [...sys.checkpoints.values()].map((c) => structuredClone(c)),
      save: async (cp) => {
        sys.checkpoints.set(cp.key, JSON.parse(JSON.stringify(cp)) as V3Checkpoint);
      },
    },
    currentSpec: async () => ({ spec: emptySpec("Ночной сервис"), version: sys.version }),
    commit: async ({ files }) => {
      sys.version += 1;
      sys.files = { ...files };
      return { revision: sys.version };
    },
    runGates: async (level) => gates(level, sys.version),
    composer: fakeComposer(),
    preview: async () => ({ ok: true, problems: [] }),
  };
  const out = await runBuildV3(host, {
    now: () => clock.t,
    appName: "Ночной сервис",
    roles: o.roles ?? true,
    rolesPhotos: [PHOTO],
    // A seed of photos for the pool: the stage reads them from the checkpoint of the photos stage.
  });
  return { out, sys, model, events };
}

describe("pipeline of roles on the flagship build", () => {
  test("all roles run, each artifact is saved as a record, the page is blocks of the catalog and one signature section", async () => {
    const { out, sys, model } = await buildFlagship();
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    const roles = out.roles;
    expect(roles).toBeDefined();
    // Roles in chain order; the signature section has two candidates and a judge of another model.
    expect(roleCalls(model)).toEqual([
      "role_strategist",
      "role_copywriter",
      "role_editor",
      "role_director",
      "signature_section",
      "signature_section",
      "role_judge",
    ]);
    // The editor is of another family than the copywriter, the second candidate than the first, the judge than both.
    expect(model.calls.filter((c) => c.callType !== "page_compose")[2]?.avoid).toContain("glm");
    expect(model.calls.filter((c) => c.callType !== "page_compose")[5]?.avoid).toContain("glm");
    expect(model.calls.filter((c) => c.callType !== "page_compose")[6]?.avoid).toEqual(
      expect.arrayContaining(["glm", "kimi"]),
    );
    // Records.
    for (const name of ["positioning", "copy", "copy-edited", "blocks", "signature"])
      expect(sys.checkpoints.has(`roles:${name}`), name).toBe(true);
    expect(roles?.artifacts).toEqual(["positioning", "copy", "copy-edited", "blocks", "signature"]);
    // The page: only catalog blocks and the one signature section.
    const home = Object.entries(sys.files).find(
      ([p, src]) => p.startsWith("ui/pages/") && src.includes("BlockById"),
    );
    expect(home, "home page from blocks").toBeDefined();
    const used = [...(home?.[1] ?? "").matchAll(/<BlockById[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(used).toEqual(PAGE_IDS);
    expect(used.every((id) => BLOCKS.some((b) => b.spec.id === id))).toBe(true);
    expect((home?.[1].match(/<Signature \/>/g) ?? []).length).toBe(1);
    expect(home?.[1]).toContain('from "../sections/v5-signature"');
    expect(sys.files["ui/sections/v5-signature.tsx"]).toContain("export default function");
    // The v3 page critic is off in this mode; the critic of roles had no browser here and says so.
    expect(roles?.notes.join(" ")).toContain("Критик по снимкам пропущен");
  });

  test("the cost of the build is ≤ 500 ₽ in the report, the roles' share is its own line", async () => {
    const { out } = await buildFlagship();
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    expect(out.costRub).toBeLessThanOrEqual(500);
    expect(out.roles?.costRub).toBeGreaterThan(0);
    expect(out.roles?.costRub).toBeLessThanOrEqual(out.costRub);
    expect(out.roles?.costRub).toBeCloseTo(7 * 3 * reg.rubPerCredit, 1);
  });

  test("roles off: the v3 path as before, no records, no roles report", async () => {
    const { out, sys, model } = await buildFlagship({ roles: false });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    expect(out.roles).toBeUndefined();
    expect(roleCalls(model)).toEqual([]);
    expect([...sys.checkpoints.keys()].some((k) => k.startsWith("roles:"))).toBe(false);
  });

  test("a repeat build reuses the records and pays nothing for the roles", async () => {
    const first = await buildFlagship();
    expect(first.out.status).toBe("succeeded");
    expect(roleCalls(first.model).length).toBe(7);
    const again = await buildFlagship({ sys: first.sys });
    if (again.out.status !== "succeeded") throw new Error(JSON.stringify(again.out));
    expect(roleCalls(again.model)).toEqual([]);
    expect(again.out.roles?.artifacts).toEqual(["positioning", "copy", "copy-edited", "blocks", "signature"]);
    expect(again.out.roles?.costRub).toBe(0);
  });

  test("a role that gives nothing keeps the v3 page and says so", async () => {
    const { out, sys } = await buildFlagship({
      answer: { role_director: () => ({ direction: DIRECTION, blocks: [] }) },
    });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    expect(out.summary_ru).toContain("Роли не справились (director)");
    expect(Object.values(sys.files).some((s) => s.includes("BlockById"))).toBe(false);
  });
});

describe("checks of a page of blocks", () => {
  const good = { direction: DIRECTION, blocks: PAGE_IDS.map((id) => ({ id, content: fillBlock(id) })) };
  test("the filled page passes", () => {
    expect(pageIssues(good, [PHOTO])).toEqual([]);
  });
  test("a block outside the catalog, a slot over its limit, a photo outside the pool, a slop text", () => {
    const bad = structuredClone(good);
    (bad.blocks[2] as { id: string }).id = "masterskaya.menu";
    const over = structuredClone(good);
    const hero = over.blocks[1] as { content: Record<string, unknown> };
    const k = Object.keys(hero.content).find((x) => typeof hero.content[x] === "string") as string;
    hero.content[k] = "а".repeat(200);
    const slop = structuredClone(good);
    const h = slop.blocks[1] as { content: Record<string, unknown> };
    h.content[k] = "Мы заботимся о вас";
    expect(pageIssues(bad, [PHOTO]).map((i) => i.code)).toContain("UNKNOWN_BLOCK");
    expect(pageIssues(over, [PHOTO]).map((i) => i.code)).toContain("SLOT");
    expect(pageIssues(good, []).map((i) => i.code)).toContain("PHOTO");
    expect(pageIssues(slop, [PHOTO]).map((i) => i.code)).toContain("SLOP");
    expect(contentErrors(PAGE_IDS[1] as string, good.blocks[1]?.content)).toEqual([]);
  });
  test("the home source imports only the catalog's renderer and the signature", () => {
    const src = homeSource(good, PAGE_IDS[1] as string);
    expect(src).toContain('from "@wizard/ui-kit"');
    expect(src).toContain("<Signature />");
    expect(homeSource(good, null)).not.toContain("Signature");
  });
  test("signature section: raw colours and foreign imports are refused", () => {
    expect(signatureSourceIssues(SIGNATURE)).toEqual([]);
    expect(
      signatureSourceIssues(SIGNATURE.replace("bg-surface", "bg-[#ff00aa]")).map((i) => i.code),
    ).toContain("RAW_COLOR");
    expect(signatureSourceIssues(`import x from "lodash";\n${SIGNATURE}`).map((i) => i.code)).toContain(
      "IMPORT",
    );
  });
});
