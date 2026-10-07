// Photos stage of builder v2 (B2-38, D61; agents/builder.yaml#v2.stages photos): after the design, without models.
// Every photo slot of the landing (photoSlots: first screen, «О нас», alternating features, gallery) gets a query from
// the niche, the section and the photo style (stock/query.ts), the stocks are searched in order (Pexels, then Pixabay),
// the chosen file is downloaded through the platform egress and copied into the platform photo library; the plan gets
// design.photos with the source, author, links and licence of every picture. No key, no network, a stock error or the
// time budget over — the slot keeps the theme graphic and the build goes on (never a failure).
import { MAX_PLAN_PHOTOS, type PlanPhoto, type SystemPlan } from "@wizard/appspec";
import { type PhotoSlot, photoSlots } from "@wizard/modules";
import { STOCK_LICENSES, type StockClient, type StockHit, type StockProvider } from "../../stock/client.js";
import { stockQuery } from "../../stock/query.js";

/** What the host gives the photos stage (platform-api: egress fetch, platform keys, runtime photo library). */
export interface PhotoHost {
  stock: StockClient;
  /** Copies the downloaded file into the platform photo library (runtime storeLibraryPhoto); id and size of the copy. */
  store(hit: StockHit, bytes: Uint8Array): Promise<{ id: string; width: number; height: number }>;
}

/** Time budget of the stage (searches, downloads, re-encoding). */
export const PHOTOS_TIME_BUDGET_MS = 45_000;

export interface PhotosOutcome {
  plan: SystemPlan;
  slots: number;
  picked: number;
  providers: StockProvider[];
  /** true — some slots keep the theme graphic because the stock was unavailable. */
  fallback: boolean;
  note: string;
}

const withPhotos = (plan: SystemPlan, photos: PlanPhoto[]): SystemPlan => {
  const { photos: _old, ...design } = plan.design;
  return { ...plan, design: photos.length ? { ...design, photos } : design };
};

/** Smallest acceptable width: the first screen and the story are shown large. */
const minWidth = (s: Pick<PhotoSlot, "type">) => (s.type === "hero" || s.type === "about" ? 1200 : 800);

/** A photo suits a slot: wide enough and of the slot's orientation (the CI photo library picks by the same rule). */
export const fitsSlot = (
  h: Pick<StockHit, "width" | "height">,
  s: Pick<PhotoSlot, "type" | "orientation">,
): boolean => {
  if (h.width < minWidth(s)) return false;
  const r = h.width / h.height;
  return s.orientation === "landscape"
    ? r >= 1.15
    : s.orientation === "portrait"
      ? r <= 0.9
      : r > 0.8 && r < 1.25;
};

const altOf = (plan: SystemPlan, s: PhotoSlot) => `${s.label} — фото по теме «${plan.niche}»`.slice(0, 160);

/** Picks stock photos for the plan's landing; never throws for a stock problem. */
export async function runPhotosStage(o: {
  plan: SystemPlan;
  host?: PhotoHost | undefined;
  now?: () => number;
  budgetMs?: number;
  signal?: AbortSignal;
}): Promise<PhotosOutcome> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const budget = o.budgetMs ?? PHOTOS_TIME_BUDGET_MS;
  const landing = o.plan.modules.find((m) => m.id === "landing");
  const done = (photos: PlanPhoto[], extra: Partial<PhotosOutcome> & { note: string }): PhotosOutcome => ({
    plan: withPhotos(o.plan, photos),
    slots: 0,
    picked: photos.length,
    providers: [],
    fallback: false,
    ...extra,
  });
  if (!landing || landing.params?.photos === false || !o.plan.landing)
    return done([], { note: "фото на сайте выключены" });
  const slots = photoSlots(o.plan, MAX_PLAN_PHOTOS);
  if (slots.length === 0) return done([], { note: "на странице нет мест для фото" });
  const stock = o.host?.stock;
  if (!o.host || !stock || stock.providers.length === 0)
    return done([], {
      slots: slots.length,
      fallback: true,
      note: "сток недоступен (нет ключа) — в секциях графика оформления",
    });
  const host = o.host;
  const pickedAt = new Date(now()).toISOString().slice(0, 10);
  const used = new Set<string>();
  const photos: PlanPhoto[] = [];
  const providers = new Set<StockProvider>();
  let errors = 0;
  // Distinct failures (up to 3: one per provider and step), for the stage note (build_metrics, the D76 report): stock
  // errors carry no keys.
  const failures: string[] = [];
  const failed = (what: string, e: unknown) => {
    errors++;
    const line = `${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    if (failures.length < 3 && !failures.includes(line)) failures.push(line);
  };
  const late = () => now() - t0 > budget || o.signal?.aborted === true;

  // One search per section type and orientation; the slots of a group take its hits in order.
  const groups = new Map<string, PhotoSlot[]>();
  for (const s of slots) {
    const k = `${s.type}|${s.orientation}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const group of groups.values()) {
    const first = group[0] as PhotoSlot;
    const q = stockQuery(o.plan, first.type, first.orientation);
    let todo = [...group];
    for (const provider of stock.providers) {
      if (todo.length === 0 || late()) break;
      let hits: StockHit[];
      try {
        hits = await stock.search(provider, q, Math.min(30, Math.max(6, todo.length * 3)), o.signal);
      } catch (e) {
        failed(`поиск ${provider}`, e);
        continue;
      }
      let attempts = todo.length + 3;
      for (const hit of hits) {
        const slot = todo[0];
        if (!slot || attempts <= 0 || late()) break;
        const key = `${hit.provider}:${hit.id}`;
        if (used.has(key) || !fitsSlot(hit, slot)) continue;
        used.add(key);
        attempts--;
        let step = "скачивание";
        try {
          const bytes = await stock.download(hit, o.signal);
          step = "копия";
          const copy = await host.store(hit, bytes);
          photos.push({
            slot: slot.slot,
            file: copy.id,
            alt: altOf(o.plan, slot),
            provider: hit.provider,
            stockId: hit.id,
            author: hit.author,
            ...(hit.authorUrl ? { authorUrl: hit.authorUrl } : {}),
            pageUrl: hit.pageUrl,
            ...STOCK_LICENSES[hit.provider],
            width: copy.width,
            height: copy.height,
            pickedAt,
          });
          providers.add(hit.provider);
          todo = todo.slice(1);
        } catch (e) {
          failed(`${step} ${hit.provider}`, e);
        }
      }
    }
  }
  const order = new Map(slots.map((s, i) => [s.slot, i]));
  photos.sort((a, b) => (order.get(a.slot) ?? 0) - (order.get(b.slot) ?? 0));
  const missing = slots.length - photos.length;
  const why = late()
    ? "не уложились во время этапа"
    : errors
      ? `сток ответил ошибкой (${failures.join("; ")})`
      : "сток не нашёл подходящих";
  return done(photos, {
    slots: slots.length,
    providers: [...providers].sort(),
    fallback: missing > 0 && (errors > 0 || late()),
    note:
      `фото со стока: ${photos.length} из ${slots.length}` +
      (providers.size ? ` (${[...providers].sort().join(", ")})` : "") +
      (missing > 0 ? `; ${missing} — графика оформления: ${why}` : ""),
  });
}
