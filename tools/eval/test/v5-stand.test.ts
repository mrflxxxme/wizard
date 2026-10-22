// V5-02: the evaluation stand — blindness of the judges, the shuffle of the pairs, the share and the cost in the
// report, fixture CLI end to end, the judges against the model registry. No network.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MODELS } from "../../../packages/llm/src/registry.ts";
import { main } from "../v5/cli.mjs";
import {
  buildPairs,
  JUDGES,
  judgeInput,
  judgePairs,
  loadBriefs,
  loadRefs,
  parseVerdict,
  refShotPath,
  selectBriefs,
  summarize,
  WIDTHS,
  WORKFLOW_CAP_RUB,
} from "../v5/lib.mjs";

const briefs = loadBriefs();
const refs = loadRefs();
const mk = (seed: string) => buildPairs({ briefs, refs, seed, placeholders: true });
const ids = (ps: { briefId: string }[]) => ps.map((p) => p.briefId);

describe("состав стенда", () => {
  test("10 брифов, срез из 3, у каждого свой эталон: 8 poehali и 2 планки", () => {
    expect(briefs).toHaveLength(10);
    expect(selectBriefs("slice")).toHaveLength(3);
    expect(new Set(ids(briefs.map((b: { id: string }) => ({ briefId: b.id })))).size).toBe(10);
    expect(refs.filter((r: { kind: string }) => r.kind === "poehali")).toHaveLength(8);
    expect(refs.filter((r: { kind: string }) => r.kind === "plank")).toHaveLength(2);
    for (const b of briefs) expect(refs.filter((r: { brief: string }) => r.brief === b.id)).toHaveLength(1);
  });
  test("снимки эталонов 1440 и 390 лежат в репозитории", () => {
    for (const r of refs)
      for (const w of WIDTHS) {
        const f = refShotPath(r, w);
        expect(existsSync(f), `${r.id} ${w}`).toBe(true);
        // One format for every source: the type of the file must not tell a judge where a snapshot came from.
        expect(readFileSync(f).subarray(1, 4).toString()).toBe("PNG");
      }
  });
  test("судьи — 3 модели разных провайдеров со зрением из реестра", () => {
    expect(JUDGES).toHaveLength(3);
    const defs = JUDGES.map((id) => MODELS.find((m) => m.id === id));
    for (const d of defs) {
      expect(d?.vision).toBe(true);
      expect(d?.enabled).toBe(true);
    }
    expect(new Set(defs.map((d) => d?.provider)).size).toBe(3);
  });
});

describe("слепота и перемешивание", () => {
  test("вход судьи не содержит ни источника, ни ключа, ни путей; вложения называются A/B", () => {
    for (const p of mk("s1")) {
      const inp = judgeInput(p);
      const names = inp.attachments.map((a: { name: string }) => a.name);
      expect(names).toEqual(["A-1440", "A-390", "B-1440", "B-390"]);
      const flat = JSON.stringify({ s: inp.system, t: inp.text, n: names });
      expect(flat).not.toMatch(/wizard|эталон|poehali|plank|ref-|v5-\d\d|docs\/prototypes/i);
      expect(inp).not.toHaveProperty("key");
    }
  });
  test("сторона Wizard случайна, порядок пар зависит от seed", () => {
    const sides = new Set<string>();
    const orders = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const ps = mk(`seed-${i}`);
      for (const p of ps) sides.add(p.key.A);
      orders.add(ids(ps).join());
    }
    expect(sides).toEqual(new Set(["wizard", "ref"]));
    expect(orders.size).toBeGreaterThan(10);
  });
  test("один seed — тот же порядок и ключи; порядок не равен порядку брифов", () => {
    expect(mk("same").map((p) => [p.briefId, p.key])).toEqual(mk("same").map((p) => [p.briefId, p.key]));
    expect(ids(mk("same"))).not.toEqual(briefs.map((b: { id: string }) => b.id));
  });
  test("Wizard слева примерно в половине пар: на 200 пар 40–60 %", () => {
    let left = 0;
    for (let i = 0; i < 20; i++) left += mk(`bal-${i}`).filter((p) => p.key.A === "wizard").length;
    expect(left / 200).toBeGreaterThan(0.4);
    expect(left / 200).toBeLessThan(0.6);
  });
  test("судья получает те же байты, что лежат в стороне A/B по ключу", () => {
    const p = mk("bytes")[0];
    expect(p.images.A[1440].data).toBe(p.sides[p.key.A][1440].data);
    expect(p.images.B[390].data).toBe(p.sides[p.key.B][390].data);
  });
});

describe("прогон и отчёт", () => {
  test("parseVerdict", () => {
    expect(parseVerdict('текст {"winner":"A","reason":"x"}')).toBe("A");
    expect(parseVerdict('{"winner":"tie"}')).toBe("tie");
    expect(parseVerdict('{"winner":"C"}')).toBeNull();
    expect(parseVerdict("нет")).toBeNull();
  });
  test("доля «не хуже» и стоимость: судьи всегда за эталон → 0 %, всегда за Wizard → 100 %", async () => {
    const pairs = mk("share");
    const byKey = (who: string) => {
      let i = 0;
      return async () => {
        const p = pairs[Math.floor(i++ / JUDGES.length)];
        return { text: JSON.stringify({ winner: p.key.A === who ? "A" : "B" }), costRub: 1.5 };
      };
    };
    const refRun = await judgePairs({ pairs, judge: byKey("ref") });
    const s0 = summarize({ ...refRun, mode: "fixture", seed: "share", set: "full" });
    expect(s0.share).toBe(0);
    expect(s0.costRub).toBe(45);
    const wRun = await judgePairs({ pairs, judge: byKey("wizard") });
    expect(summarize({ ...wRun, mode: "live", seed: "share", set: "full" }).share).toBe(1);
  });
  test("потолок трат останавливает новые пары; потолок выше 1 500 ₽ отвергается", async () => {
    const pairs = mk("cap");
    const r = await judgePairs({ pairs, capRub: 10, judge: async () => ({ text: '{"winner":"tie"}', costRub: 4 }) });
    expect(r.stoppedByCap).toBe(true);
    expect(r.pairs.some((p: { result: string }) => p.result === "skipped_by_cap")).toBe(true);
    await expect(judgePairs({ pairs, capRub: WORKFLOW_CAP_RUB + 1, judge: async () => ({ text: "", costRub: 0 }) })).rejects.toThrow(/потолок/);
  });
  test("снимок не получен: пара вне доли, судьи не вызываются", async () => {
    const pairs = buildPairs({ briefs, refs, seed: "miss" });
    let calls = 0;
    const r = await judgePairs({
      pairs,
      judge: async () => {
        calls++;
        return { text: "", costRub: 0 };
      },
    });
    expect(calls).toBe(0);
    const s = summarize({ ...r, mode: "live", seed: "miss", set: "full" });
    expect(s.share).toBeNull();
    expect(s.noSnapshot).toHaveLength(10);
  });
  test("CLI fixture: отчёт с долей, стоимостью и лентой пар; срез из 3", async () => {
    const out = mkdtempSync(join(tmpdir(), "v5-"));
    await main(["run", "--set", "slice", "--out", out], { log: () => {} });
    const s = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(s.pairs).toBe(3);
    expect(s.costRub).toBe(0);
    expect(s.share).not.toBeNull();
    expect(readFileSync(join(out, "report.md"), "utf8")).toMatch(/Стоимость прогона/);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/Лента пар/);
    expect(html.match(/<section class="pair/g)).toHaveLength(3);
    expect(existsSync(join(out, "img"))).toBe(true);
  });
});

describe("живой судья", () => {
  test("считает стоимость по записям использования и останавливается на потолке", async () => {
    const { createLiveJudge } = await import("../v5/live-judge.ts");
    const calls: string[] = [];
    const judge = createLiveJudge({
      judges: JUDGES,
      capRub: 3,
      env: {},
      router: (_reg: unknown, onUsage: (u: { costRub: number }) => void) => ({
        route: async (input: { messages: { role: string; attachments?: unknown[] }[] }) => {
          calls.push(String(input.messages[1].attachments?.length));
          onUsage({ costRub: 2 });
          return { result: { text: '{"winner":"A"}' } };
        },
      }),
    } as never);
    const inp = judgeInput(mk("live")[0]);
    expect(await judge("kimi-k3", inp as never)).toEqual({ text: '{"winner":"A"}', costRub: 2 });
    await judge("kimi-k3", inp as never);
    await expect(judge("kimi-k3", inp as never)).rejects.toThrow(/потолок/);
    expect(calls).toEqual(["4", "4"]);
  });
});
