// Photo library filled from CI (B2-43, D61): the stocks are closed for the server in RF (on the pilot Pexels answers
// 404, Pixabay resets the connection), while GitHub runners reach them. The runner (tools/deploy/stock-library.mjs)
// picks photos for fixed queries, copies them into the platform photo library (runtime storeLibraryPhoto) and keeps
// this index next to the copies; a build with WIZARD_STOCK_MODE=library answers its stock searches from the index and
// never calls a stock. Queries come from the same stockQuery as the photos stage, so a seeded query matches exactly;
// other plans fall back to the photos of their niche, then to the generic ones.
import type { SystemPlan } from "@wizard/appspec";
import type { PhotoOrientation, PhotoSectionType } from "@wizard/modules";
import { z } from "zod";
import { STOCK_PROVIDERS, type StockClient, StockError, type StockHit } from "./client.js";
import { GENERIC_TERMS, NICHE_TERMS, type StockQuery, stockQuery } from "./query.js";

export const LIBRARY_INDEX_VERSION = 1;
/** Entries of the whole index at most (≈ 350 bytes each). */
export const LIBRARY_MAX_ENTRIES = 5000;
/** How long a process keeps the index it read before reading it again. */
export const LIBRARY_INDEX_TTL_MS = 5 * 60_000;

const entrySchema = z.object({
  query: z.string().min(1).max(80),
  orientation: z.enum(["landscape", "portrait", "square"]),
  provider: z.enum(["pexels", "pixabay"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** Library photo id (runtime libraryPhotoId of `provider:id`). */
  file: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  author: z.string().min(1).max(120),
  authorUrl: z.url({ protocol: /^https$/ }).optional(),
  pageUrl: z.url({ protocol: /^https$/ }),
  license: z.string().min(1).max(80),
  licenseUrl: z.url({ protocol: /^https$/ }),
  /** Size of the library copy (the largest WebP variant). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pickedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** One photo of the library: the query it was picked for, the stock source with its licence, the library copy. */
export type LibraryEntry = z.infer<typeof entrySchema>;

export interface LibraryIndex {
  version: typeof LIBRARY_INDEX_VERSION;
  entries: LibraryEntry[];
}

export const emptyLibraryIndex = (): LibraryIndex => ({ version: LIBRARY_INDEX_VERSION, entries: [] });

const keyOf = (q: { query: string; orientation: string }) => `${q.query}|${q.orientation}`;
const sourceOf = (e: { provider: string; id: string }) => `${e.provider}:${e.id}`;

/** The index from its stored bytes (null — none yet); invalid entries are dropped, a broken file throws. */
export function parseLibraryIndex(raw: Uint8Array | string | null): LibraryIndex {
  if (raw === null) return emptyLibraryIndex();
  let doc: unknown;
  try {
    doc = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw new Error("photo library index: not JSON");
  }
  const top = z
    .object({ version: z.literal(LIBRARY_INDEX_VERSION), entries: z.array(z.unknown()) })
    .safeParse(doc);
  if (!top.success) throw new Error("photo library index: unknown format");
  const entries = top.data.entries.flatMap((e) => {
    const r = entrySchema.safeParse(e);
    return r.success ? [r.data] : [];
  });
  return mergeLibraryIndex(emptyLibraryIndex(), entries, { cap: () => Number.POSITIVE_INFINITY });
}

/** Stored form: entries grouped by query in a fixed order, one line each (the same index gives the same bytes). */
export function serializeLibraryIndex(index: LibraryIndex): string {
  const fields = Object.keys(entrySchema.shape) as (keyof LibraryEntry)[];
  const lines = index.entries.map(
    (e) =>
      `    ${JSON.stringify(Object.fromEntries(fields.flatMap((k) => (e[k] === undefined ? [] : [[k, e[k]]]))))}`,
  );
  return `{\n  "version": ${LIBRARY_INDEX_VERSION},\n  "entries": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

/** Subjects of the niche dictionary with the section they serve (longest first: «barber shop» before «barber»). */
const SUBJECTS: readonly { subject: string; section: "hero" | "about" | "detail" }[] = [
  ...NICHE_TERMS.flatMap((n) => [
    { subject: n.hero, section: "hero" as const },
    { subject: n.about, section: "about" as const },
    { subject: n.detail, section: "detail" as const },
  ]),
  { subject: GENERIC_TERMS.hero, section: "hero" as const },
  { subject: GENERIC_TERMS.about, section: "about" as const },
  { subject: GENERIC_TERMS.detail, section: "detail" as const },
].sort((a, b) => b.subject.length - a.subject.length);

/** The niche subject a query starts with («dental clinic daylight» → «dental clinic»); undefined — none known. */
export function querySubject(
  text: string,
): { subject: string; section: "hero" | "about" | "detail" } | undefined {
  return SUBJECTS.find((s) => text === s.subject || text.startsWith(`${s.subject} `));
}

/** Photos kept per query: hero and about 6, details 10 (features and the gallery share them), collage 3 + 4. */
export function libraryCap(q: { query: string; orientation: PhotoOrientation }): number {
  if (q.orientation === "portrait") return 3;
  if (q.orientation === "square") return 4;
  return querySubject(q.query)?.section === "detail" ? 10 : 6;
}

/**
 * `base` with `added` merged: one entry per stock photo (provider:id), at most `cap` per query and orientation for the
 * added ones (base entries are always kept), LIBRARY_MAX_ENTRIES in all; entries grouped by query in a fixed order,
 * the pick order kept inside a query.
 */
export function mergeLibraryIndex(
  base: LibraryIndex,
  added: readonly LibraryEntry[],
  o: { cap?: (q: { query: string; orientation: PhotoOrientation }) => number } = {},
): LibraryIndex {
  const cap = o.cap ?? libraryCap;
  const seen = new Set<string>();
  const count = new Map<string, number>();
  const out: LibraryEntry[] = [];
  const take = (e: LibraryEntry, capped: boolean) => {
    const k = keyOf(e);
    const n = count.get(k) ?? 0;
    if (seen.has(sourceOf(e)) || out.length >= LIBRARY_MAX_ENTRIES || (capped && n >= cap(e))) return;
    seen.add(sourceOf(e));
    count.set(k, n + 1);
    out.push(e);
  };
  for (const e of base.entries) take(e, false);
  for (const e of added) take(e, true);
  out.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  return { version: LIBRARY_INDEX_VERSION, entries: out };
}

/** Photos of the index for one query and orientation. */
export const libraryCount = (index: LibraryIndex, q: StockQuery): number =>
  index.entries.filter((e) => e.query === q.text && e.orientation === q.orientation).length;

/**
 * Niches of small businesses the library is seeded for (Russian, as a plan names them): one per entry of NICHE_TERMS
 * in its order (a test keeps them in step), then "" — the generic terms.
 */
export const CATALOG_NICHES: readonly string[] = [
  "стоматология",
  "ветеринарная клиника",
  "медицинская клиника",
  "психолог",
  "барбершоп",
  "парикмахерская",
  "маникюр и педикюр",
  "салон красоты",
  "массаж",
  "студия йоги",
  "школа танцев",
  "фитнес-клуб",
  "бассейн",
  "детский развивающий центр",
  "курсы английского языка",
  "вокальная студия",
  "художественная студия",
  "фотограф и фотосессии",
  "свадьбы и праздники",
  "кофейня",
  "пекарня",
  "ресторан",
  "цветочный магазин",
  "клининг",
  "ремонт квартир",
  "мебель на заказ",
  "автосервис",
  "ремонт телефонов",
  "юридические услуги",
  "бухгалтерские услуги",
  "агентство недвижимости",
  "туры и путешествия",
  "коворкинг",
  "прокат снаряжения",
  "магазин одежды",
  "",
];

/** Section types and orientations the photos stage asks (photoSlots): the collage's portrait and squares last. */
export const LIBRARY_SLOT_KINDS: readonly { type: PhotoSectionType; orientation: PhotoOrientation }[] = [
  { type: "hero", orientation: "landscape" },
  { type: "about", orientation: "landscape" },
  { type: "features", orientation: "landscape" },
  { type: "gallery", orientation: "landscape" },
  { type: "hero", orientation: "portrait" },
  { type: "hero", orientation: "square" },
];

export interface SeedQuery extends StockQuery {
  /** The section a photo of the query is checked against (fitsSlot). */
  type: PhotoSectionType;
  cap: number;
}

/**
 * Queries of one seeding in priority order (a run stops at its request cap; the next one goes on where it stopped):
 * `first` (the exact queries of known plans), then the niche queries of CATALOG_NICHES without a photo style, kind by
 * kind. The same text and orientation once.
 */
export function librarySeedQueries(
  first: readonly (StockQuery & { type: PhotoSectionType })[] = [],
): SeedQuery[] {
  const out: SeedQuery[] = [];
  const seen = new Set<string>();
  const add = (q: StockQuery & { type: PhotoSectionType }) => {
    const k = `${q.text}|${q.orientation}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...q, cap: libraryCap({ query: q.text, orientation: q.orientation }) });
  };
  for (const q of first) add(q);
  for (const kind of LIBRARY_SLOT_KINDS)
    for (const niche of CATALOG_NICHES)
      add({
        ...stockQuery({ niche, goals: [], design: { photoStyle: "" } }, kind.type, kind.orientation),
        type: kind.type,
      });
  return out;
}

/** The exact queries of a plan's photo slots (one per section type and orientation, as the photos stage asks). */
export function planSeedQueries(
  plan: Pick<SystemPlan, "niche" | "goals"> & { design: Pick<SystemPlan["design"], "photoStyle"> },
  slots: readonly { type: PhotoSectionType; orientation: PhotoOrientation }[],
): (StockQuery & { type: PhotoSectionType })[] {
  const kinds = new Map(slots.map((s) => [`${s.type}|${s.orientation}`, s]));
  return [...kinds.values()].map((s) => ({ ...stockQuery(plan, s.type, s.orientation), type: s.type }));
}

/** An entry of the library as a stock hit (downloadUrl is never fetched: the copy is already in the library). */
const hitOf = (e: LibraryEntry): StockHit => ({
  provider: e.provider,
  id: e.id,
  width: e.width,
  height: e.height,
  author: e.author,
  ...(e.authorUrl ? { authorUrl: e.authorUrl } : {}),
  pageUrl: e.pageUrl,
  downloadUrl: `library:${e.file}`,
});

/**
 * Hits of the index for a query: the exact query, then the other queries of its niche subject, then the generic
 * subject of the same section; the orientation always matches. Index order inside a tier.
 */
export function librarySearch(index: LibraryIndex, q: StockQuery, limit: number): StockHit[] {
  const own = querySubject(q.text);
  const generic = own
    ? [GENERIC_TERMS[own.section]]
    : [GENERIC_TERMS.hero, GENERIC_TERMS.about, GENERIC_TERMS.detail];
  const same = index.entries.filter((e) => e.orientation === q.orientation);
  const subjectOf = (e: LibraryEntry) => querySubject(e.query)?.subject;
  const tiers = [
    same.filter((e) => e.query === q.text),
    own ? same.filter((e) => e.query !== q.text && subjectOf(e) === own.subject) : [],
    same.filter((e) => generic.includes(subjectOf(e) ?? "")),
  ];
  const seen = new Set<string>();
  const out: StockHit[] = [];
  for (const e of tiers.flat()) {
    if (out.length >= limit) break;
    if (seen.has(sourceOf(e))) continue;
    seen.add(sourceOf(e));
    out.push(hitOf(e));
  }
  return out;
}

export interface LibraryStockClient extends StockClient {
  /** Library photo id of a hit the library answered; undefined — not a library photo. */
  fileOf(hit: Pick<StockHit, "provider" | "id">): string | undefined;
}

/**
 * The stock client of library mode: no network, the index read through `load` (the platform: the shared file storage)
 * and kept for `ttlMs`. The library is one source: it lists one provider, and that search answers the photos of both
 * stocks in tier order (a niche photo of Pixabay never loses to a generic one of Pexels); a hit keeps its own
 * provider, licence and author. download gives no bytes — the host's store returns the library copy.
 */
export function createLibraryStockClient(o: {
  load: () => Promise<LibraryIndex>;
  ttlMs?: number;
  now?: () => number;
}): LibraryStockClient {
  const ttl = o.ttlMs ?? LIBRARY_INDEX_TTL_MS;
  const now = o.now ?? Date.now;
  let cached: { at: number; index: LibraryIndex; files: Map<string, string> } | undefined;
  let pending: Promise<NonNullable<typeof cached>> | undefined;
  const current = async () => {
    if (cached && now() - cached.at <= ttl) return cached;
    pending ??= o
      .load()
      .then((index) => {
        cached = { at: now(), index, files: new Map(index.entries.map((e) => [sourceOf(e), e.file])) };
        return cached;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const lead = STOCK_PROVIDERS[0] as (typeof STOCK_PROVIDERS)[number];
  return {
    providers: [lead],
    async search(_provider, q, perPage) {
      let lib: NonNullable<typeof cached>;
      try {
        lib = await current();
      } catch {
        throw new StockError("BAD_RESPONSE", lead, "photo library index");
      }
      return librarySearch(lib.index, q, perPage);
    },
    async download(hit) {
      if (!cached?.files.has(sourceOf(hit)))
        throw new StockError("HOST", hit.provider, "not in the photo library");
      return new Uint8Array(0);
    },
    fileOf: (hit) => cached?.files.get(sourceOf(hit)),
  };
}
