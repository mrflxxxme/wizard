// V4-10 (D79 (6)): the photos of a site from the semantic library. A Russian query from the brief per section kind
// («стоматология — первый экран», «… — люди за работой», «… — детали работы») finds candidates by meaning (SigLIP,
// semantic.ts) that fit each slot (orientation, size); the top 20 go to a vision model (photo_pick) that assigns the
// slots by meaning and by the direction's palette, and the slots it leaves go to the best remaining candidates. No
// photo twice on a site. Too few photos on the topic queue the niche for backfill (CI) — the build takes what there is.
import type { PlanPhoto, SystemPlan } from "@wizard/appspec";
import type { PhotoSlot } from "@wizard/modules";
import { STOCK_LICENSES } from "./client.js";
import {
  type Candidate,
  flagTextPhotos,
  type LibraryObjects,
  type LibraryPhotoEntry,
  loadSemanticLibrary,
  needsBackfill,
  readFlags,
  requestBackfill,
  SEMANTIC_OBJECTS,
  type SearchOptions,
  type SemanticLibrary,
  sourceOf,
} from "./semantic.js";
import {
  ensureModelFiles,
  lazyTextEncoder,
  loadTextEncoder,
  SIGLIP,
  TEXT_FILES,
  type TextEmbedder,
} from "./siglip.js";

/** What the host gives: search by a Russian query, the backfill queue, a small copy of a photo for the vision model. */
export interface SemanticPhotoSource {
  search(text: string, o: SearchOptions): Promise<Candidate[]>;
  requestBackfill(text: string): Promise<void>;
  /** A 480 px WebP of a library photo (null — none). */
  thumbnail(file: string): Promise<Uint8Array | null>;
  /** V4-26: marks library photos with readable text (search never returns them again). */
  flagText?(files: readonly string[]): Promise<void>;
}

/** What the vision model is asked: the site, its slots and the numbered candidates (1-based in the prompt). */
export interface PickInput {
  niche: string;
  style: string;
  /** Colours of the direction (#RRGGBB): accent first. */
  palette: string[];
  slots: { slot: string; label: string; orientation: PhotoSlot["orientation"] }[];
  candidates: { entry: LibraryPhotoEntry; thumbnail: Uint8Array }[];
}

/**
 * One answer of the model: slot → candidate index (0-based), or V4-26 a candidate with readable text in the frame (a
 * sign, a caption, a logo, a watermark), which goes to no slot.
 */
export type PickAnswer = { slot: string; index: number } | { text: number };

/** The model's answers; null — the model failed (rank order is used). */
export type PhotoPicker = (input: PickInput) => Promise<PickAnswer[] | null>;

/** Candidates the vision model sees at most. */
export const PICK_CANDIDATES = 20;

/** What a slot kind shows, for the query (the niche leads: the meaning of the business comes first). */
const KIND_QUERY: Record<PhotoSlot["type"], string> = {
  hero: "",
  about: "люди за работой, мастер с клиентом",
  features: "детали работы, процесс",
  gallery: "результат работы, интерьер",
};

/** The Russian query of a slot kind: the niche, what the section shows, the photo style of the direction. */
export function photoQueryText(
  plan: Pick<SystemPlan, "niche"> & { design?: { photoStyle?: string | undefined } },
  type: PhotoSlot["type"],
): string {
  return [plan.niche, KIND_QUERY[type], plan.design?.photoStyle ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ")
    .slice(0, 200);
}

/** Smallest acceptable width: the first screen and the story are shown large (= builder photos fitsSlot). */
const minWidth = (t: PhotoSlot["type"]) => (t === "hero" || t === "about" ? 1200 : 800);

/** A library photo fits a slot: its orientation and wide enough. */
export function fitsPhotoSlot(
  e: Pick<LibraryPhotoEntry, "width" | "height">,
  s: Pick<PhotoSlot, "type" | "orientation">,
): boolean {
  if (e.width < minWidth(s.type)) return false;
  const r = e.width / e.height;
  return s.orientation === "landscape"
    ? r >= 1.15
    : s.orientation === "portrait"
      ? r <= 0.9
      : r > 0.8 && r < 1.25;
}

export interface SemanticPhotosResult {
  photos: PlanPhoto[];
  /** true — the vision model chose (false: rank order, no model or it failed). */
  picked: boolean;
  /** true — the niche went to the backfill queue. */
  backfill: boolean;
  candidates: number;
}

/**
 * Photos for `slots`: candidates per slot kind (search, fitting, never a photo used before on the site), the top
 * PICK_CANDIDATES to the picker, then every slot the picker left takes the best unused candidate that fits it.
 */
export async function semanticPhotos(o: {
  plan: Pick<SystemPlan, "niche"> & {
    design?: { photoStyle?: string | undefined; accent?: string | undefined };
  };
  slots: readonly PhotoSlot[];
  source: SemanticPhotoSource;
  picker?: PhotoPicker | undefined;
  palette?: string[];
  /** `provider:id` already on the site (other pages, the owner's choice). */
  used?: ReadonlySet<string>;
  pickedAt: string;
}): Promise<SemanticPhotosResult> {
  const used = new Set(o.used ?? []);
  const kinds = new Map<string, PhotoSlot[]>();
  for (const s of o.slots)
    kinds.set(`${s.type}|${s.orientation}`, [...(kinds.get(`${s.type}|${s.orientation}`) ?? []), s]);
  // Candidates of every kind, best first; each kind keeps its own ranking for the fallback.
  const byKind = new Map<string, Candidate[]>();
  for (const [k, group] of kinds) {
    const first = group[0] as PhotoSlot;
    const found = await o.source.search(photoQueryText(o.plan, first.type), {
      limit: PICK_CANDIDATES,
      filter: (e) => fitsPhotoSlot(e, first),
      exclude: used,
    });
    byKind.set(k, found);
  }
  // The pool for the picker: kinds take turns, so every kind has its candidates in the 20.
  const pool: Candidate[] = [];
  const seen = new Set<string>();
  const lists = [...byKind.values()];
  for (let i = 0; pool.length < PICK_CANDIDATES && lists.some((l) => l.length > i); i++)
    for (const l of lists) {
      const c = l[i];
      if (!c || seen.has(sourceOf(c.entry)) || pool.length >= PICK_CANDIDATES) continue;
      seen.add(sourceOf(c.entry));
      pool.push(c);
    }

  // The topic as a whole (every kind's candidates): few close photos — a niche the library lacks.
  const backfill = o.slots.length > 0 && needsBackfill(pool);
  if (backfill) await o.source.requestBackfill(o.plan.niche).catch(() => {});

  const assigned = new Map<string, LibraryPhotoEntry>();
  // V4-27: one photo per author on a site — one shoot shows one model, and a person three times reads as the staff.
  const authors = new Set<string>();
  let picked = false;
  if (o.picker && pool.length > 0) {
    const withThumbs: { entry: LibraryPhotoEntry; thumbnail: Uint8Array }[] = [];
    for (const c of pool) {
      const t = await o.source.thumbnail(c.entry.file).catch(() => null);
      if (t) withThumbs.push({ entry: c.entry, thumbnail: t });
    }
    const answer = withThumbs.length
      ? await o
          .picker({
            niche: o.plan.niche,
            style: o.plan.design?.photoStyle ?? "",
            palette: o.palette ?? (o.plan.design?.accent ? [o.plan.design.accent] : []),
            slots: o.slots.map((s) => ({ slot: s.slot, label: s.label, orientation: s.orientation })),
            candidates: withThumbs,
          })
          .catch(() => null)
      : null;
    if (answer) {
      // V4-26: photos with text go nowhere on this site, and the library remembers them for every next search.
      const text = answer.flatMap((a) => {
        const e = "text" in a ? withThumbs[a.text]?.entry : undefined;
        return e ? [e] : [];
      });
      for (const e of text) used.add(sourceOf(e));
      if (text.length && o.source.flagText) await o.source.flagText(text.map((e) => e.file)).catch(() => {});
      for (const a of answer) {
        if (!("slot" in a)) continue;
        const slot = o.slots.find((s) => s.slot === a.slot);
        const entry = withThumbs[a.index]?.entry;
        if (
          !slot ||
          !entry ||
          assigned.has(slot.slot) ||
          used.has(sourceOf(entry)) ||
          authors.has(entry.author) ||
          !fitsPhotoSlot(entry, slot)
        )
          continue;
        assigned.set(slot.slot, entry);
        used.add(sourceOf(entry));
        authors.add(entry.author);
      }
      picked = assigned.size > 0;
    }
  }
  for (const s of o.slots) {
    if (assigned.has(s.slot)) continue;
    const kind = byKind.get(`${s.type}|${s.orientation}`) ?? [];
    const free = (c: Candidate) => !used.has(sourceOf(c.entry));
    const next = kind.find((c) => free(c) && !authors.has(c.entry.author)) ?? kind.find(free);
    if (!next) continue;
    assigned.set(s.slot, next.entry);
    used.add(sourceOf(next.entry));
    authors.add(next.entry.author);
  }
  const photos: PlanPhoto[] = o.slots.flatMap((s) => {
    const e = assigned.get(s.slot);
    if (!e) return [];
    return [
      {
        slot: s.slot,
        file: e.file,
        alt: `${s.label} — фото по теме «${o.plan.niche}»`.slice(0, 160),
        provider: e.provider,
        stockId: e.id,
        author: e.author,
        ...(e.authorUrl ? { authorUrl: e.authorUrl } : {}),
        pageUrl: e.pageUrl,
        ...STOCK_LICENSES[e.provider],
        width: e.width,
        height: e.height,
        pickedAt: o.pickedAt,
      },
    ];
  });
  return { photos, picked, backfill, candidates: pool.length };
}

/** Photos the library holds before a thin topic counts as a niche to backfill (the catalog is mostly filled). */
export const BACKFILL_MIN_LIBRARY = 5000;

/** How long the platform keeps the loaded library before reading the manifest again. */
export const SEMANTIC_TTL_MS = 10 * 60_000;

/**
 * The platform's semantic source over the library objects: the shards loaded on first use and re-read after `ttlMs`
 * (CI keeps filling them), the text tower fetched from the same storage into `modelDir` and loaded lazily (released
 * after idle). No library yet — no candidates (the photos stage then goes the stock way).
 */
export function createSemanticSource(o: {
  objects: LibraryObjects;
  modelDir: string;
  thumbnail: (file: string) => Promise<Uint8Array | null>;
  ttlMs?: number;
  now?: () => number;
  encoder?: TextEmbedder;
}): SemanticPhotoSource & { close(): Promise<void> } {
  const ttl = o.ttlMs ?? SEMANTIC_TTL_MS;
  const now = o.now ?? Date.now;
  let cached: { at: number; lib: SemanticLibrary | null } | undefined;
  let pending: Promise<SemanticLibrary | null> | undefined;
  /** V4-26: photos with readable text (the library's flags and the ones this process flagged since). */
  const textPhotos = new Set<string>();
  const library = async () => {
    if (cached && now() - cached.at <= ttl) return cached.lib;
    pending ??= Promise.all([loadSemanticLibrary(o.objects), readFlags(o.objects).catch(() => null)])
      .then(([lib, flags]) => {
        cached = { at: now(), lib };
        for (const f of flags?.text ?? []) textPhotos.add(f);
        return lib;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const encoder =
    o.encoder ??
    lazyTextEncoder(async () => {
      await ensureModelFiles(o.modelDir, TEXT_FILES, (f) =>
        o.objects.get(SEMANTIC_OBJECTS.model(SIGLIP.files[f].path)),
      );
      return loadTextEncoder(o.modelDir);
    });
  return {
    async search(query, so) {
      const lib = await library();
      if (!lib || lib.size === 0) return [];
      const filter = so.filter;
      return lib.search(await encoder.encode(query), {
        ...so,
        filter: (e) => !textPhotos.has(e.file) && (!filter || filter(e)),
      });
    },
    async flagText(files) {
      for (const f of files) textPhotos.add(f);
      await flagTextPhotos(o.objects, files);
    },
    async requestBackfill(text) {
      // While CI is still filling the catalog, a thin topic is not a new niche yet.
      if (((await library())?.size ?? 0) >= BACKFILL_MIN_LIBRARY) await requestBackfill(o.objects, text);
    },
    thumbnail: o.thumbnail,
    close: () => encoder.close(),
  };
}
