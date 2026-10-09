// useSitePhotos (V3-18, C4): the owner's photos of the site on a v3 page without markup — the same data the v2 landing
// shows (B2-38, @wizard/modules landing/photos.ts): one site_photo row per place («слот») the owner replaced in
// «Фото сайта» of the cabinet; a place without a row keeps the stock photo of the plan (the props of the section).
// The page file of the composer asks it for the places its sections show; the patterns stay plain props.
import { useMemo } from "react";
import { useDataSource } from "../../data/context.js";
import type { ImageWidth, Rec } from "../../data/types.js";

/** A picture of a pattern slot (imageSlot of the library): a same-origin address and its alternative text. */
export interface SitePhoto {
  src: string;
  alt: string;
}

/** Widths the runtime serves for a picture (/api/files/<id>/img/<w>, /_wizard/photos/<file>/<w>). */
export const IMAGE_WIDTHS = [480, 960, 1600] as const;

const VARIANT_RE = /^(.*\/(?:api\/files\/[^/?#]+\/img|_wizard\/photos\/[^/?#]+))\/(?:480|960|1600)$/;

/**
 * The srcset of a picture the runtime serves in widths (V3-18): «…/480 480w, …/960 960w, …/1600 1600w» for an address
 * of a width variant (an image field, the platform photo library); undefined for any other address.
 */
export function srcSetOf(src: string | null | undefined): string | undefined {
  const m = src ? VARIANT_RE.exec(src) : null;
  return m ? IMAGE_WIDTHS.map((w) => `${m[1]}/${w} ${w}w`).join(", ") : undefined;
}

/** Names of the landing module's photo entity (@wizard/modules SITE_PHOTO). */
export const SITE_PHOTO_DEFAULTS = {
  entity: "site_photo",
  slot: "slot",
  image: "image",
  alt: "alt",
} as const;

export interface SitePhotos {
  /** The picture of a place: the owner's photo, else `fallback` (the stock photo of the section or nothing). */
  one<F extends SitePhoto | undefined>(slot: string, fallback: F): SitePhoto | F;
  /** Pictures of a section's places in order: each the owner's photo or the picture of the list at its index. */
  list<T extends SitePhoto>(slots: readonly string[], fallback: readonly T[]): T[];
  /** Items with a picture each (services): `image` of the item at index i — the owner's photo of slots[i] or its own. */
  items<T extends object>(items: readonly T[], slots: readonly string[]): T[];
  /** The owner's photos by place. */
  own: ReadonlyMap<string, SitePhoto>;
}

export interface UseSitePhotosOptions {
  /** Width of the image variant served for an owner's photo (default 1600: first screens are wide). */
  width?: ImageWidth;
  entity?: string;
}

/** The owner's photos of the site's places over the DataSource; a role that may not read them sees the stock ones. */
export function useSitePhotos(o: UseSitePhotosOptions = {}): SitePhotos {
  const ds = useDataSource();
  const files = ds.useFiles();
  const n = { ...SITE_PHOTO_DEFAULTS, ...(o.entity ? { entity: o.entity } : {}) };
  const rows = ds.useList<Rec>(n.entity, { pageSize: 50 });
  const width = o.width ?? 1600;
  const items = rows.data?.items;
  const own = useMemo(() => {
    const out = new Map<string, SitePhoto>();
    for (const r of items ?? []) {
      const slot = r[n.slot];
      const file = r[n.image];
      if (typeof slot !== "string" || typeof file !== "string" || !file) continue;
      const alt = typeof r[n.alt] === "string" && (r[n.alt] as string).trim() ? (r[n.alt] as string) : "Фото";
      out.set(slot, { src: files.imageSrc(file, width), alt });
    }
    return out;
  }, [items, files, width, n.slot, n.image, n.alt]);
  return useMemo(
    () => ({
      own,
      one: <F extends SitePhoto | undefined>(slot: string, fallback: F): SitePhoto | F =>
        own.get(slot) ?? fallback,
      list: <T extends SitePhoto>(slots: readonly string[], fallback: readonly T[]): T[] =>
        fallback.map((p, i) => {
          const mine = own.get(slots[i] ?? "");
          return mine ? { ...p, src: mine.src, alt: mine.alt } : p;
        }),
      items: <T extends object>(list: readonly T[], slots: readonly string[]): T[] =>
        list.map((item, i) => {
          const mine = own.get(slots[i] ?? "");
          return mine ? { ...item, image: mine } : item;
        }),
    }),
    [own],
  );
}
