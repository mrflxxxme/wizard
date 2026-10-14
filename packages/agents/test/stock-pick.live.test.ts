// V4-10 live probe of photo_pick (plan v4 §5.2, D79 (10)): glm-5v-turbo and kimi-k3 pick a site's photos among 8
// candidates — 4 on the niche's topic, 4 from other niches, V4-26 one storefront with a sign — on 3 niches, through the real gateway (live mode,
// platform keys from env). Skipped unless WIZARD_STAGE_PROBE=1: it runs only in GitHub Actions (stock-library.yml,
// action probe). Candidates are Openverse thumbnails fetched for the run (never stored). Prints one record per call
// (choices, share on topic, the sign listed as text and kept off the slots, ₽, ms; never keys) and the summary table.
// V4-27: and the card check of a dental clinic — three rows, each with its own photo and a stranger (another medicine,
// a sign): «Вывеска на месте» there means a stranger on a card.
import { createRegistry, createRouter, MemoryUsageSink, type Registry } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { type LibraryPhotoEntry, modelPhotoPicker, type PickInput } from "../src/stock/index.js";

const ON = process.env.WIZARD_STAGE_PROBE === "1";
const OPEN = { ruOnly: false, t1Restricted: false };

const only = (model: string): Registry => {
  const base = createRegistry({ buildDefaultTier: "T1" });
  return {
    ...base,
    routes: { ...base.routes, photo_pick: { ...base.routes.photo_pick, chain: { T1: [model] } } },
  };
};

/** Niche (Russian, as a brief says it) and its English search for the candidates. */
const NICHES = [
  { niche: "клининг, уборка квартир", q: "house cleaning" },
  { niche: "монтаж кондиционеров", q: "air conditioner installation" },
  { niche: "стоматология", q: "dentist patient" },
];
const OFF = ["office money calculator", "city street night", "food market", "laptop desk"];
/** V4-26: photos with a readable sign — the model should list them in text and put them on no slot. */
const SIGNS = "clinic storefront sign";

async function thumbs(q: string, n: number): Promise<{ bytes: Uint8Array; width: number; height: number }[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n + 6}&license_type=commercial&extension=jpg&aspect_ratio=wide`;
  const r = (await (await fetch(url)).json()) as { results: { thumbnail: string }[] };
  const out: { bytes: Uint8Array; width: number; height: number }[] = [];
  for (const it of r.results) {
    if (out.length >= n) break;
    const res = await fetch(it.thumbnail).catch(() => null);
    if (!res?.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0xff) out.push({ bytes, width: 1800, height: 1200 });
  }
  return out;
}

let seq = 0;
const entry = (w: number, h: number): LibraryPhotoEntry => {
  seq++;
  return {
    provider: "pexels",
    id: String(seq),
    file: `00000000-0000-5000-8000-${seq.toString(16).padStart(12, "0")}`,
    author: "Автор",
    pageUrl: `https://www.pexels.com/photo/${seq}/`,
    width: w,
    height: h,
    color: "#8a8f96",
    luma: 0.5,
    query: "probe",
    niche: "probe",
  };
};

describe.skipIf(!ON)("V4-10 live probe of photo_pick", () => {
  test(
    "the vision models pick the on-topic photos, one per slot",
    async () => {
      const off = (await Promise.all(OFF.map((q) => thumbs(q, 1)))).flat();
      const signs = await thumbs(SIGNS, NICHES.length);
      const records: Record<string, unknown>[] = [];
      for (const n of NICHES) {
        const on = await thumbs(n.q, 4);
        // On-topic and off-topic interleaved, so the order says nothing.
        const sign = signs[NICHES.indexOf(n)];
        const pool = on.flatMap((x, i) => [
          { ...x, on: true, sign: false },
          ...(off[i] ? [{ ...off[i], on: false, sign: false }] : []),
          ...(i === 1 && sign ? [{ ...sign, on: false, sign: true }] : []),
        ]);
        const input: PickInput = {
          niche: n.niche,
          style: "светлые естественные фото",
          palette: ["#2A7F9E", "#F4F1EA"],
          slots: [
            { slot: "top", label: "Первый экран", orientation: "landscape" },
            { slot: "about", label: "О нас", orientation: "landscape" },
            { slot: "gallery", label: "Галерея, фото 1", orientation: "landscape" },
          ],
          candidates: pool.map((p) => ({ entry: entry(p.width, p.height), thumbnail: p.bytes })),
        };
        for (const model of ["glm-5v-turbo", "kimi-k3"]) {
          const sink = new MemoryUsageSink();
          const router = createRouter({ mode: "live", registry: only(model), sink });
          const t0 = Date.now();
          const picker = modelPhotoPicker({
            route: (i) => router.route(i),
            orgPolicy: OPEN,
            ctx: { orgId: "00000000-0000-4000-8000-0000000000f5" },
          });
          const answer = await picker(input);
          const choices = answer?.flatMap((a) => ("slot" in a ? [a] : [])) ?? null;
          const text = answer?.flatMap((a) => ("text" in a ? [a.text] : [])) ?? [];
          const onTopic = choices?.filter((c) => pool[c.index]?.on).length ?? 0;
          records.push({
            id: `photo_pick:${model}:${n.niche}`,
            status: choices ? "ok" : "error",
            candidates: pool.length,
            choices,
            onTopic: choices?.length ? onTopic / choices.length : null,
            text,
            signFlagged: pool.some((x) => x.sign) ? text.some((i) => pool[i]?.sign) : null,
            signPlaced: choices?.some((c) => pool[c.index]?.sign) ?? false,
            rub: sink.records.reduce((s, r) => s + r.costRub, 0),
            ms: Date.now() - t0,
            attempts: sink.records.map((r) => `${r.modelId}:${r.status}:${r.errorCode ?? ""}`),
          });
          console.log(`photo_pick_probe=${JSON.stringify(records.at(-1))}`);
        }
      }
      // V4-27: the card check of a dental clinic — a row per service, its own photo and a stranger (another medicine,
      // a sign); the model should take the dental one for every row.
      const cardRows = [
        { label: "Терапия", on: "dentist treatment patient", off: "gynecology examination chair" },
        { label: "Хирургия", on: "dental surgery", off: "hospital ward bed" },
        { label: "Ортодонтия", on: "dental braces orthodontist", off: SIGNS },
      ];
      const cardPool: { bytes: Uint8Array; width: number; height: number; row: number; on: boolean }[] = [];
      for (const [i, r] of cardRows.entries()) {
        const [on] = await thumbs(r.on, 1);
        const [off] = await thumbs(r.off, 1);
        // The stranger first: the order says nothing.
        if (off) cardPool.push({ ...off, row: i, on: false });
        if (on) cardPool.push({ ...on, row: i, on: true });
      }
      const cards: PickInput = {
        niche: "стоматология",
        style: "",
        palette: [],
        slots: cardRows.map((r, i) => ({
          slot: `card-${i + 1}`,
          label: `Карточка каталога «${r.label}»`,
          orientation: "landscape" as const,
        })),
        candidates: cardPool.map((p) => ({ entry: entry(p.width, p.height), thumbnail: p.bytes })),
      };
      for (const model of ["glm-5v-turbo", "kimi-k3"]) {
        const sink = new MemoryUsageSink();
        const router = createRouter({ mode: "live", registry: only(model), sink });
        const t0 = Date.now();
        const answer = await modelPhotoPicker({
          route: (i) => router.route(i),
          orgPolicy: OPEN,
          ctx: { orgId: "00000000-0000-4000-8000-0000000000f5" },
          stepName: "photo_cards",
        })(cards);
        const choices = answer?.flatMap((a) => ("slot" in a ? [a] : [])) ?? null;
        const right =
          choices?.filter(
            (c) => cardPool[c.index]?.on && `card-${(cardPool[c.index]?.row ?? -1) + 1}` === c.slot,
          ).length ?? 0;
        records.push({
          id: `photo_cards:${model}:стоматология`,
          status: choices ? "ok" : "error",
          candidates: cardPool.length,
          choices,
          onTopic: choices?.length ? right / choices.length : null,
          text: answer?.flatMap((a) => ("text" in a ? [a.text] : [])) ?? [],
          signFlagged: null,
          signPlaced: choices?.some((c) => !cardPool[c.index]?.on) ?? false,
          rub: sink.records.reduce((s, r) => s + r.costRub, 0),
          ms: Date.now() - t0,
          attempts: sink.records.map((r) => `${r.modelId}:${r.status}:${r.errorCode ?? ""}`),
        });
        console.log(`photo_pick_probe=${JSON.stringify(records.at(-1))}`);
      }
      const rub = records.reduce((s, r) => s + Number(r.rub ?? 0), 0);
      const table = records.map(
        (r) =>
          `| ${r.id} | ${r.status === "ok" ? "✅" : "❌"} | ${r.onTopic ?? "—"} | ${r.signFlagged ?? "—"} | ${r.signPlaced} | ${r.ms} | ${Number(r.rub).toFixed(3)} | ${JSON.stringify(r.choices ?? r.attempts)} |`,
      );
      const summary = `## Живая проба photo_pick (V4-10)\n\nИтого ${rub.toFixed(2)} ₽\n\n| Проба | Статус | Доля по теме | Вывеска найдена | Вывеска на месте | мс | ₽ | Выбор |\n|---|---|---|---|---|---|---|---|\n${table.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(records.length).toBe(NICHES.length * 2 + 2);
    },
    20 * 60_000,
  );
});
