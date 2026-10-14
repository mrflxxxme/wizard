// The photos of the catalog cards of a draft (the image fields a visitor reads: services, goods, projects) from the
// semantic library (V4-10). V4-22: one photo per row, searched by the row's name. V4-26: by the site's niche and only in
// the niche shards of the site's own photos. V4-27: in the build, one photo_pick call checks every row's candidates at
// once (text in the frame, the niche's equipment) and the verdict is kept for the seed of the draft (checkpoint
// «card_photos»): a foreign sign or another medicine never lands on a card.
import { createHash } from "node:crypto";
import {
  CATALOG,
  type LibraryPhotoEntry,
  nicheStems,
  type PhotoPicker,
  type SemanticPhotoSource,
} from "@wizard/agents/stock";
import type { AppSpec } from "@wizard/appspec";
import { LIBRARY_PHOTO_HINT, SEED_HINT_MAX_VALUES, type SeedHint } from "@wizard/gates";

/** @wizard/modules SITE_PHOTO.entity: one row per place the owner replaced — never a demo row with a photo. */
export const SITE_PHOTO_ENTITY = "site_photo";

/**
 * D49: entities a site passes off as its own — the owner's doctors, masters, team, the works of its portfolio and its
 * projects, the reviews (avatars). A stock photo there would show strangers as the staff and others' work as the masters': these cards
 * keep no photo (the site shows initials or nothing) without the owner's own, never a library one.
 */
const PERSON_ENTITY =
  /^(specialist|staff|doctor|master|employee|team|member|trainer|teacher|coach|tutor|stylist|barber|instructor|expert|person|people|author|portfolio|work|review|testimonial|project)(s|_.*)?$/;

/** true — `entity` is the site's own people or work (D49): no stock photo ever goes on its cards. */
export const isPersonEntity = (entity: string): boolean => PERSON_ENTITY.test(entity);

/** Rows a field without name hints gets photos for. */
const UNNAMED_ROWS = 6;

/** Rows one check sends to the vision model (2 candidates each: ≈0,8 ₽ and ≈10 s on glm-5v-turbo). */
export const CHECKED_ROWS = 6;

/** Candidates per row the check chooses from. */
const CHECK_CANDIDATES = 2;

/**
 * V4-30: the next candidates of a row its second round chooses from: deeper than the first (photos with text are
 * flagged out of the library as the check sees them, and an empty catalog was 5 of 15 sites with 2).
 */
const SECOND_ROUND_CANDIDATES = 4;

/** Image fields of the entities a public role reads (goods, catalog items, article covers); never the site's own photos. */
export function publicImageFields(spec: AppSpec): { entity: string; field: string }[] {
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  const fields: { entity: string; field: string }[] = [];
  for (const e of spec.entities) {
    if (e.name === SITE_PHOTO_ENTITY || isPersonEntity(e.name)) continue;
    const readable = spec.permissions.some(
      (p) => p.entity === e.name && publicRoles.has(p.role) && p.ops.includes("read"),
    );
    if (!readable) continue;
    for (const f of e.fields) if (f.type === "image") fields.push({ entity: e.name, field: f.name });
  }
  return fields;
}

/** The niche the photos stage searched for (its alt «… — фото по теме «<niche>»», photos.ts semanticPhotos). */
export function planNiche(plan: readonly unknown[]): string | null {
  for (const p of plan) {
    const alt = (p as { alt?: unknown })?.alt;
    const m = typeof alt === "string" ? /по теме «([^»]{2,120})»$/.exec(alt) : null;
    if (m?.[1]) return m[1];
  }
  return null;
}

const stems = nicheStems;

/**
 * V4-28: the library niches a row names itself («Брови и ресницы» → brows, «Маникюр и педикюр» → nails): a salon's
 * site photos come from one shard (hair), its cards of other directions take their own. [] — the row names none.
 */
export function rowNiches(row: string): string[] {
  const own = stems(row);
  if (own.size === 0) return [];
  return CATALOG.filter((c) => [...stems(c.name)].some((s) => own.has(s))).map((c) => c.slug);
}

/** One card row and its candidates, best first. */
export interface CardRow {
  /** V4-27: the next candidates of the row, for the second round of the check. */
  extra?: LibraryPhotoEntry[];
  /** The row's name («Терапия»), or its number when the brief names none. */
  label: string;
  candidates: LibraryPhotoEntry[];
}

/** The verdict of a check: a photo per row (null — none fits), or null when the check failed. */
export type CardCheck = (rows: readonly CardRow[]) => Promise<(LibraryPhotoEntry | null)[] | null>;

/**
 * V4-22: image hints from the semantic library — one photo per row, searched by the site's niche (else its name) and
 * the row's name (the name hints of the same entity, in row order), else by the niche alone; landscape, never twice,
 * never one of `used` (the plan's photos). V4-26: only from the niche shards the plan's photos came from — «Терапия» of
 * a dental clinic is a dentist's chair, not a gynecologist's. V4-27: with `check`, each of the first CHECKED_ROWS rows
 * takes the photo the check gives among its two candidates (the rest take their first). [] — no library or nothing fits.
 */
export async function semanticSeedHints(
  spec: AppSpec,
  hints: readonly SeedHint[],
  used: ReadonlySet<string>,
  covered: ReadonlySet<string>,
  source: Pick<SemanticPhotoSource, "search">,
  topic: { niche?: string; check?: CardCheck } = {},
): Promise<SeedHint[]> {
  const site = topic.niche?.trim() || spec.app.name.trim();
  const taken = new Set(used);
  const own = [...used].filter(Boolean);
  const shards = new Set(
    own.length
      ? (
          await source
            .search(site.slice(0, 200), { limit: own.length, filter: (e) => used.has(e.file) })
            .catch(() => [])
        ).map((c) => c.entry.niche)
      : [],
  );
  const inNiche = (e: { niche: string }) => shards.size === 0 || shards.has(e.niche);
  const per = topic.check ? CHECK_CANDIDATES : 1;
  // With a check, the next candidates of a row wait for its second round.
  const more = topic.check ? SECOND_ROUND_CANDIDATES : 0;
  const fetch = per + more;
  const search = async (q: string, n: number, own: readonly string[] = []): Promise<LibraryPhotoEntry[]> =>
    (
      await source
        .search(q.slice(0, 200), {
          limit: n + 4,
          filter: (e) =>
            e.width >= e.height * 1.15 &&
            !taken.has(e.file) &&
            (own.length ? own.includes(e.niche) : inNiche(e)),
        })
        .catch(() => [])
    )
      .map((c) => c.entry)
      .filter((e) => !taken.has(e.file))
      .slice(0, n);
  const fields: { entity: string; field: string; named: boolean; rows: CardRow[] }[] = [];
  for (const f of publicImageFields(spec)) {
    if (covered.has(`${f.entity}.${f.field}`) || covered.has(f.entity)) continue;
    const names = hints.find((h) => h.entity === f.entity && h.field === "name")?.values.map(String) ?? [];
    const rows: CardRow[] = [];
    if (names.length) {
      for (const n of names) {
        // A row of another direction («Брови и ресницы» of a salon) searches its own niche; a row whose niches take in
        // the site's own («Детская стоматология» of a clinic) stays in the site's.
        const own = rowNiches(n);
        const found = await search(`${site}, ${n}`, fetch, own.some((x) => shards.has(x)) ? [] : own);
        // A row without a photo ends the list: the photos follow the rows in order.
        if (!found.length) break;
        for (const e of found) taken.add(e.file);
        rows.push({ label: n, candidates: found.slice(0, per), extra: found.slice(per) });
      }
    } else {
      const found = await search(site, UNNAMED_ROWS * fetch);
      for (const e of found) taken.add(e.file);
      const first = Math.min(found.length, UNNAMED_ROWS * per);
      for (let i = 0; i < first; i += per) {
        const r = rows.length;
        rows.push({
          label: String(r + 1),
          candidates: found.slice(i, i + per),
          extra: found.slice(first + r * more, first + (r + 1) * more),
        });
      }
    }
    fields.push({ ...f, named: names.length > 0, rows });
  }
  const all = fields.flatMap((x) => x.rows);
  const checked = all.slice(0, CHECKED_ROWS);
  const verdict = topic.check && all.length ? await topic.check(checked).catch(() => null) : null;
  // V4-27: the rows the check left empty get one more round with their next candidates (one call, only if any).
  if (verdict && topic.check) {
    const empty = checked.flatMap((r, i) => (!verdict[i] && r.extra?.length ? [i] : []));
    if (empty.length) {
      const again = await topic
        .check(empty.map((i) => ({ label: checked[i]?.label ?? "", candidates: checked[i]?.extra ?? [] })))
        .catch(() => null);
      empty.forEach((i, j) => {
        const e = again?.[j];
        if (e) verdict[i] = e;
      });
    }
  }
  const out: SeedHint[] = [];
  let k = 0;
  for (const x of fields) {
    const values: string[] = [];
    let empty = false;
    for (const r of x.rows) {
      const i = k++;
      const e = verdict && i < verdict.length ? verdict[i] : r.candidates[0];
      if (e) values.push(`/_wizard/photos/${e.file}/960`);
      else empty = true;
    }
    // A catalog with a card the check found nothing for shows no photos at all — uniformly, never 3 of 4 (a card
    // without a photo among cards with photos reads as broken, S03), never a wrong photo.
    if (empty) continue;
    const ok = values.filter((v) => LIBRARY_PHOTO_HINT.test(v)).slice(0, SEED_HINT_MAX_VALUES);
    if (ok.length) out.push({ entity: x.entity, field: x.field, values: ok });
  }
  return out;
}

/**
 * V4-27: the check of the card rows by the vision model (photo_pick): a slot per row with its candidates, the niche of
 * the site. Each row takes the model's photo; a row the model left empty (nothing shows what the card names) or gave a
 * photo with text gets none (semanticSeedHints then tries its next candidates once, and a catalog still with an empty
 * card shows no photos at all). Photos with text are flagged in the library. null — the model
 * failed (the rows take their first candidates, as without a check).
 */
export function pickerCardCheck(o: {
  picker: PhotoPicker;
  niche: string;
  source: Pick<SemanticPhotoSource, "thumbnail" | "flagText">;
}): CardCheck {
  return async (rows) => {
    const pool: { entry: LibraryPhotoEntry; thumbnail: Uint8Array }[] = [];
    for (const r of rows)
      for (const e of r.candidates) {
        if (pool.some((p) => p.entry.file === e.file)) continue;
        const t = await o.source.thumbnail(e.file).catch(() => null);
        if (t) pool.push({ entry: e, thumbnail: t });
      }
    if (pool.length === 0) return null;
    const slotOf = (i: number) => `card-${i + 1}`;
    const answer = await o
      .picker({
        niche: o.niche,
        style: "",
        palette: [],
        slots: rows.map((r, i) => ({
          slot: slotOf(i),
          label: /^\d+$/.test(r.label) ? `Карточка каталога ${r.label}` : `Карточка каталога «${r.label}»`,
          orientation: "landscape" as const,
        })),
        candidates: pool,
      })
      .catch(() => null);
    if (!answer) return null;
    const text = new Set<string>();
    for (const a of answer) {
      const e = "text" in a ? pool[a.text]?.entry : undefined;
      if (e) text.add(e.file);
    }
    if (text.size && o.source.flagText) await o.source.flagText([...text]).catch(() => {});
    const taken = new Set<string>();
    return rows.map((_r, i) => {
      const chosen = answer.flatMap((a) =>
        "slot" in a && a.slot === slotOf(i) ? [pool[a.index]?.entry] : [],
      )[0];
      // Any candidate of the call may go to the row (a croissant found for «Завтраки» shows «Десерты» as well), once.
      const own = (e: LibraryPhotoEntry | undefined): e is LibraryPhotoEntry =>
        !!e && !text.has(e.file) && !taken.has(e.file);
      // The model left the card empty or chose a photo with text: the card shows none (rule 6), not a wrong one.
      if (!own(chosen)) return null;
      taken.add(chosen.file);
      return chosen;
    });
  };
}

/** The key of a card check: the same rows, plan photos and niche reuse its verdict. */
export function cardPhotosKey(o: {
  spec: AppSpec;
  hints: readonly SeedHint[];
  used: ReadonlySet<string>;
  covered: ReadonlySet<string>;
  niche: string | null;
}): string {
  const fields = publicImageFields(o.spec);
  const names = o.hints.filter((h) => h.field === "name" && fields.some((f) => f.entity === h.entity));
  return createHash("sha256")
    .update(
      JSON.stringify({
        fields,
        names: names.map((h) => [h.entity, h.values]),
        used: [...o.used].sort(),
        covered: [...o.covered].sort(),
        niche: o.niche,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}
