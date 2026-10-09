// V3-40: the blind comparison of the final v3 measurement (tools/eval/blind) — the layout of the pairs (a fixed seed
// gives the same page; the page never shows a source), the folders of the screenshots, the sum of the raters' answers
// (Wizard ≥ 70 % of the pairs, enough raters, «one template» complaints) and the CLI end to end. No network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { aggregateVotes, BLIND_TARGETS, blindLines } from "../blind/aggregate.mjs";
import { main as blindMain } from "../blind/cli.mjs";
import { blindLayout, collectSites, seededRandom, shuffle } from "../blind/layout.mjs";
import { renderBlindPage, VOTES_KIND, VOTES_VERSION } from "../blind/page.mjs";
import { loadBriefs } from "../lib/briefs.mjs";

const briefs = loadBriefs("v3-final");
const site = (source: string, b: { id: string; class: string; title: string }, ext = ".png") => ({
  source,
  briefId: b.id,
  class: b.class,
  title: b.title,
  service: source === "wizard" ? "Wizard" : "Конкурент-Х",
  images: { 390: `/shots/${source}/${b.id}-390${ext}`, 1440: `/shots/${source}/${b.id}-1440${ext}` },
});
const sites = briefs.flatMap((b) => [site("wizard", b), site("competitor", b)]);

type KeyPair = {
  id: string;
  kind: string;
  class: string;
  A: { source: string; briefId: string };
  B: { source: string; briefId: string };
};
type Key = { layoutId: string; seed: string; pairs: KeyPair[] };
type Vote = { pair: string; better: "A" | "B" | "same" | null; sameTemplate: boolean; comment?: string };

/** A rater's file: `pick(pair)` → the answer. */
function votesOf(key: Key, rater: string, pick: (p: KeyPair) => Partial<Vote>, savedAt = "2026-10-21T10:00:00Z") {
  return {
    kind: VOTES_KIND,
    version: VOTES_VERSION,
    layoutId: key.layoutId,
    seed: key.seed,
    rater,
    savedAt,
    votes: key.pairs.map((p) => ({ pair: p.id, better: null, sameTemplate: false, ...pick(p) })),
  };
}
const wizSide = (p: KeyPair) => (p.A.source === "wizard" ? "A" : "B");
const comSide = (p: KeyPair) => (p.A.source === "wizard" ? "B" : "A");

describe("layout of the blind page", () => {
  test("the PRNG of a seed is deterministic; shuffle keeps the elements", () => {
    const a = seededRandom("v3-40");
    const b = seededRandom("v3-40");
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 5 }, seededRandom("other"))).not.toEqual(xs);
    const list = Array.from({ length: 20 }, (_, i) => i);
    expect([...shuffle(list, seededRandom("s"))].sort((x, y) => x - y)).toEqual(list);
  });

  test("a fixed seed gives the same page whatever the input order; another seed — another order", () => {
    const one = blindLayout({ sites, seed: "v3-40" });
    const again = blindLayout({ sites: [...sites].reverse(), seed: "v3-40" });
    expect(again).toEqual(one);
    expect(renderBlindPage(again)).toBe(renderBlindPage(one));
    const other = blindLayout({ sites, seed: "v3-40-b" });
    expect(other.key.pairs.map((p: KeyPair) => `${p.A.briefId}|${p.B.briefId}`)).not.toEqual(
      one.key.pairs.map((p: KeyPair) => `${p.A.briefId}|${p.B.briefId}`),
    );
    expect(() => blindLayout({ sites, seed: "" })).toThrow(/seed/);
  });

  test("pairs: Wizard–competitor per brief, Wizard–Wizard and competitor–competitor inside each class; every site as often", () => {
    const { key, pairs, files } = blindLayout({ sites, seed: "v3-40" });
    const kinds = (k: string) => key.pairs.filter((p: KeyPair) => p.kind === k);
    expect(kinds("wc")).toHaveLength(12);
    expect(kinds("ww")).toHaveLength(12);
    expect(kinds("cc")).toHaveLength(12);
    expect(pairs.map((p: { id: string }) => p.id)).toEqual(
      Array.from({ length: 36 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`),
    );
    for (const p of [...kinds("ww"), ...kinds("cc")]) {
      expect(p.A.source).toBe(p.B.source);
      expect(briefs.find((b) => b.id === p.A.briefId)?.class).toBe(briefs.find((b) => b.id === p.B.briefId)?.class);
    }
    for (const p of kinds("wc")) expect(p.A.briefId).toBe(p.B.briefId);
    // Each site shows up three times: a rater cannot tell the source by how often a site repeats.
    const seen = new Map<string, number>();
    for (const p of key.pairs) for (const s of [p.A, p.B]) seen.set(`${s.source}:${s.briefId}`, (seen.get(`${s.source}:${s.briefId}`) ?? 0) + 1);
    expect(new Set(seen.values())).toEqual(new Set([3]));
    // Wizard is A in some pairs and B in others.
    const onA = kinds("wc").filter((p: KeyPair) => p.A.source === "wizard").length;
    expect(onA).toBeGreaterThan(0);
    expect(onA).toBeLessThan(12);
    // Four images per pair under neutral names; no control pairs on request.
    expect(files).toHaveLength(36 * 4);
    expect(new Set(files.map((f: { name: string }) => f.name)).size).toBe(files.length);
    expect(files.every((f: { name: string }) => /^img\/[0-9a-f]{16}\.png$/.test(f.name))).toBe(true);
    expect(blindLayout({ sites, seed: "v3-40", controls: false }).key.pairs).toHaveLength(24);
  });

  test("the page hides the source: no service, no brief id, no file path, no word Wizard; the tasks and the controls in Russian", () => {
    const layout = blindLayout({ sites, seed: "v3-40" });
    const html = renderBlindPage(layout);
    for (const s of ["Wizard", "wizard", "Конкурент-Х", "competitor", "/shots/", "-390.png", "v3-0", "v3-1", "source"])
      expect(html, s).not.toContain(s);
    for (const p of layout.pairs) {
      expect(html).toContain(p.A.images["390"]);
      expect(html).toContain(p.B.images["1440"]);
    }
    expect(html).toContain(briefs[0].title.replace(/"/g, "&quot;"));
    for (const t of ["Слепое сравнение сайтов", "Лучше A", "Лучше B", "Одинаково", "A и B выглядят как один шаблон", "Скачать результаты", 'lang="ru"'])
      expect(html).toContain(t);
    // The data block of the page: the layout id and the pair ids only.
    const data = JSON.parse(/<script type="application\/json" id="blind-data">(.*?)<\/script>/s.exec(html)?.[1] ?? "{}");
    expect(Object.keys(data).sort()).toEqual(["layoutId", "pairs", "seed", "votesKind", "votesVersion"]);
    expect(data.pairs[0]).toEqual({ id: "p01" });
  });

  test("the folders: the run's shots/ and competitor/<brief or short id>/{390,1440} with meta.json; missing ones and formats warned", () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-"));
    const shots = join(dir, "shots");
    const comp = join(dir, "competitor");
    mkdirSync(shots);
    const two = briefs.slice(0, 2);
    for (const b of two) for (const w of ["390", "1440"]) writeFileSync(join(shots, `${b.id}-${w}.png`), "png");
    mkdirSync(join(comp, "v3-01"), { recursive: true });
    for (const w of ["390", "1440"]) writeFileSync(join(comp, "v3-01", `${w}.jpg`), "jpg");
    writeFileSync(join(comp, "v3-01", "meta.json"), JSON.stringify({ service: "Tilda AI", url: "https://example.invalid/x" }));
    const { sites: found, warnings } = collectSites({ briefs: two, wizardDir: shots, competitorDir: comp });
    expect(found.map((s: { source: string; briefId: string }) => `${s.source}:${s.briefId}`)).toEqual([
      "wizard:v3-01-interior-studio",
      "competitor:v3-01-interior-studio",
      "wizard:v3-02-dental-booking",
    ]);
    expect(found[1]).toMatchObject({ service: "Tilda AI", url: "https://example.invalid/x" });
    expect(warnings.join("\n")).toMatch(/v3-02-dental-booking: нет снимков конкурента/);
    expect(warnings.join("\n")).toMatch(/форматы снимков разные/);
  });
});

describe("the sum of the raters' answers", () => {
  const layout = blindLayout({ sites, seed: "v3-40" });
  const key = layout.key as Key;
  const wc = key.pairs.filter((p) => p.kind === "wc");

  test("Wizard wins a pair by the majority of its raters; the share against 70 %; enough raters; no «one template» of Wizard", () => {
    // Wizard wins 9 of 12 pairs: 4 raters prefer it there; in 3 pairs (the first three) the competitor wins 3:1.
    const lose = new Set(wc.slice(0, 3).map((p) => p.id));
    const files = ["Основатель", "Оценщик 1", "Оценщик 2", "Оценщик 3"].map((r, i) => ({
      name: `${r}.json`,
      data: votesOf(key, r, (p) => {
        if (p.kind !== "wc") return { better: "same" };
        if (lose.has(p.id)) return { better: i === 0 ? wizSide(p) : comSide(p) };
        return { better: wizSide(p) };
      }),
    }));
    const s = aggregateVotes(key, files);
    expect(s.ratersCount).toBe(4);
    expect(s.enoughRaters).toBe(true);
    expect(s.wc).toMatchObject({ pairs: 12, voted: 12, wizardWins: 9, competitorWins: 3, ties: 0, share: 0.75 });
    expect(s.wc.votes).toEqual({ wizard: 9 * 4 + 3, competitor: 9, same: 0 });
    expect(s.passed).toEqual({ blind: true, template: true });
    expect(Object.values(s.perClass).reduce((n: number, c) => n + (c as { of: number }).of, 0)).toBe(12);
    const text = blindLines(s).join("\n");
    expect(text).toContain("Wizard выиграл 9 из 12 пар (75 %; цель ≥ 70 %) ✅");
    expect(text).toContain("«Один шаблон» у двух сайтов Wizard: ни одной жалобы ✅");
    expect(text).toContain("Конкурент: Конкурент-Х.");
  });

  test("below 70 %, ties, too few raters, a «one template» complaint of two Wizard sites — each fails its criterion", () => {
    const ww = key.pairs.find((p) => p.kind === "ww") as KeyPair;
    const cc = key.pairs.find((p) => p.kind === "cc") as KeyPair;
    const half = new Set(wc.slice(0, 6).map((p) => p.id));
    const files = [
      {
        name: "a.json",
        data: votesOf(key, "Аня", (p) =>
          p.kind === "wc"
            ? { better: half.has(p.id) ? wizSide(p) : comSide(p) }
            : { better: "same", sameTemplate: p.id === ww.id || p.id === cc.id, comment: p.id === ww.id ? "одинаковые блоки" : "" },
        ),
      },
      { name: "b.json", data: votesOf(key, "Борис", (p) => ({ better: p.kind === "wc" ? "same" : null })) },
    ];
    const s = aggregateVotes(key, files);
    expect(s.ratersCount).toBe(2);
    expect(s.enoughRaters).toBe(false);
    expect(s.wc).toMatchObject({ wizardWins: 6, competitorWins: 6, ties: 0, share: 0.5 });
    expect(s.passed).toEqual({ blind: false, template: false });
    expect(s.template.ww).toEqual([{ pair: ww.id, class: ww.class, briefs: [ww.A.briefId, ww.B.briefId], raters: ["Аня"] }]);
    expect(s.template.cc).toHaveLength(1);
    expect(blindLines(s).join("\n")).toMatch(/«Один шаблон» у двух сайтов Wizard: 1 пар ❌/);
    // A tie of a pair: one rater each way.
    const tie = aggregateVotes(key, [
      { name: "x.json", data: votesOf(key, "X", (p) => (p.id === wc[0].id ? { better: wizSide(p) } : {})) },
      { name: "y.json", data: votesOf(key, "Y", (p) => (p.id === wc[0].id ? { better: comSide(p) } : {})) },
    ]);
    expect(tie.wc).toMatchObject({ voted: 1, ties: 1, wizardWins: 0, share: 0 });
  });

  test("files of another page are skipped; a rater counted once (the latest file); no answers — pending", () => {
    const old = votesOf(key, "Вера", (p) => (p.kind === "wc" ? { better: comSide(p) } : {}), "2026-10-21T09:00:00Z");
    const fresh = votesOf(key, "вера ", (p) => (p.kind === "wc" ? { better: wizSide(p) } : {}), "2026-10-21T11:00:00Z");
    const s = aggregateVotes(key, [
      { name: "fresh.json", data: fresh },
      { name: "old.json", data: old },
      { name: "alien.json", data: { ...fresh, layoutId: "000000000000", rater: "Чужой" } },
      { name: "broken.json", data: null },
    ]);
    expect(s.ratersCount).toBe(1);
    expect(s.wc.wizardWins).toBe(12);
    expect(s.warnings.join("\n")).toMatch(/alien\.json: ответы к другой странице/);
    expect(s.warnings.join("\n")).toMatch(/broken\.json: не JSON-объект/);
    expect(s.warnings.join("\n")).toMatch(/несколько файлов — взят последний/);
    const none = aggregateVotes(key, []);
    expect(none.passed).toEqual({ blind: null, template: null });
    expect(none.wc.share).toBeNull();
    expect(BLIND_TARGETS).toEqual({ wizardShare: 0.7, minRaters: 4 });
  });
});

describe("tools/eval/blind/cli.mjs", () => {
  test("build: the page folder with neutral images, the key outside it; aggregate: the summary and the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-cli-"));
    const shots = join(dir, "shots");
    const comp = join(dir, "competitor");
    mkdirSync(shots);
    for (const b of briefs) {
      for (const w of ["390", "1440"]) writeFileSync(join(shots, `${b.id}-${w}.png`), `w-${b.id}-${w}`);
      mkdirSync(join(comp, b.id), { recursive: true });
      for (const w of ["390", "1440"]) writeFileSync(join(comp, b.id, `${w}.png`), `c-${b.id}-${w}`);
      writeFileSync(join(comp, b.id, "meta.json"), JSON.stringify({ service: "Конструктор Y" }));
    }
    const logs: string[] = [];
    const page = join(dir, "page");
    expect(
      await blindMain(["build", "--shots", shots, "--competitor", comp, "--out", page], { log: (l: string) => logs.push(l) }),
    ).toBe(0);
    expect(readdirSync(join(page, "img"))).toHaveLength(36 * 4);
    expect(readdirSync(page).sort()).toEqual(["img", "index.html"]);
    const keyFile = `${page}-key.json`;
    expect(existsSync(keyFile)).toBe(true);
    expect(logs.join("\n")).toContain("пар 36 (Wizard — конкурент 12, Wizard — Wizard 12, конкурент — конкурент 12), seed «v3-40»");
    const key = JSON.parse(readFileSync(keyFile, "utf8"));
    // A copied image is the source's file under its neutral name.
    const first = key.pairs[0];
    const html = readFileSync(join(page, "index.html"), "utf8");
    const src = /<img src="(img\/[0-9a-f]+\.png)"/.exec(html)?.[1] as string;
    expect(readFileSync(join(page, src), "utf8")).toBe(
      `${first.A.source === "wizard" ? "w" : "c"}-${first.A.briefId}-390`,
    );
    const votes = join(dir, "votes");
    mkdirSync(votes);
    for (const r of ["Основатель", "О1", "О2", "О3"])
      writeFileSync(
        join(votes, `${r}.json`),
        JSON.stringify(votesOf(key, r, (p) => (p.kind === "wc" ? { better: wizSide(p) } : { better: "same" }))),
      );
    const out: string[] = [];
    const summary = join(dir, "blind-summary.json");
    expect(
      await blindMain(["aggregate", "--key", keyFile, "--votes", votes, "--out", summary], {
        stdout: (s: string) => out.push(s),
      }),
    ).toBe(0);
    expect(out.join("")).toContain("Wizard выиграл 12 из 12 пар (100 %");
    expect(JSON.parse(readFileSync(summary, "utf8"))).toMatchObject({ kind: "wizard-blind-summary", ratersCount: 4 });
    await expect(blindMain(["build", "--shots", shots])).rejects.toThrow(/--competitor/);
  });

  test("the CLI runs under plain node (no tsx, no network)", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "blind", "cli.mjs"), "nope"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("команда: build | aggregate");
  });
});
