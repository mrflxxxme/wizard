// Photos of the landing (B2-38, D61): which pictures the sections show (slots), where the stock copy lives (the platform
// photo library, served by the runtime at /_wizard/photos/<file>/<width>), the owner's own photo of a slot (site_photo
// rows, uploaded in the cabinet in one click), and the «Источники фото» page with the source, author and licence of
// every stock photo. A slot without a photo shows the theme graphic (ui-kit Media placeholder).
import type { PlanPhoto, PlanSection, SystemPlan } from "@wizard/appspec";
import { js } from "../screens/jsx.js";
import type { GenContext, ScreenContext } from "../types.js";
import { sectionAnchors } from "./page.js";

/** The owner's photos of the slots (one row per replaced slot; no row — the stock photo or the theme graphic). */
export const SITE_PHOTO = { entity: "site_photo", slot: "slot", image: "image", alt: "alt" } as const;
/** Runtime path of the platform photo library (runtime.yaml#service_endpoints.photos). */
export const PHOTO_LIBRARY_PATH = "/_wizard/photos";
/** Width variants of a library photo (the same slots as image fields, runtime.yaml#files.image). */
export const PHOTO_WIDTHS = [480, 960, 1600] as const;
/** Public page with the sources of the stock photos. */
export const PHOTO_CREDITS_ROUTE = "/photos";
/** The owner's page «Фото сайта». */
export const PHOTO_CABINET_ROUTE = "/cabinet/photos";
/** Helper module of the landing pages (generated per plan). */
export const PHOTO_HELPER = { file: "ui/pages/SitePhotos.tsx", importFrom: "./SitePhotos" } as const;
/** At most this many pictures per gallery and per alternating features section get a slot. */
const MAX_GALLERY = 6;
const MAX_FEATURES = 4;
/** Tiles of a gallery without items (the page shows the same number of placeholders). */
export const GALLERY_TILES = 6;

export type PhotoOrientation = "landscape" | "portrait" | "square";
export type PhotoSectionType = "hero" | "about" | "features" | "gallery";

export interface PhotoSlot {
  /** Section anchor; «-n» for the n-th picture of the section (top, top-2, about, gallery-3). */
  slot: string;
  sectionIndex: number;
  type: PhotoSectionType;
  /** 1-based number of the picture in its section. */
  n: number;
  /** Russian name of the place for the owner («Первый экран», «Галерея, фото 3»). */
  label: string;
  orientation: PhotoOrientation;
}

/** Stock providers as people read them. */
export const PROVIDER_LABEL: Readonly<Record<PlanPhoto["provider"], string>> = {
  pexels: "Pexels",
  pixabay: "Pixabay",
};

const SECTION_LABEL: Readonly<Record<PhotoSectionType, string>> = {
  hero: "Первый экран",
  about: "О нас",
  features: "Преимущества",
  gallery: "Галерея",
};

const listLength = (s: PlanSection): number => {
  const v = s.content.items;
  return Array.isArray(v) ? v.length : typeof v === "string" && v.trim() ? 1 : 0;
};

/** Pictures a section shows in its layout (the same rules as the ui-kit blocks). */
function picturesOf(s: PlanSection): number {
  switch (s.type) {
    case "hero":
      return s.variant === "collage" ? 3 : s.variant === "minimal" ? 0 : 1;
    case "about":
      return s.variant === "split" ? 1 : 0;
    case "features":
      return s.variant === "alternating" ? Math.min(MAX_FEATURES, listLength(s)) : 0;
    case "gallery":
      return Math.min(MAX_GALLERY, listLength(s) || GALLERY_TILES);
    default:
      return 0;
  }
}

const orientationOf = (type: PhotoSectionType, n: number, variant: string): PhotoOrientation =>
  type === "hero" && variant === "collage" ? (n === 1 ? "portrait" : "square") : "landscape";

/** Photo slots of the landing in page order (hero first); at most `max` of them. */
export function photoSlots(plan: Pick<SystemPlan, "landing">, max = 12): PhotoSlot[] {
  const sections = plan.landing?.sections ?? [];
  const anchors = sectionAnchors(sections);
  const out: PhotoSlot[] = [];
  sections.forEach((s, i) => {
    const count = picturesOf(s);
    const anchor = anchors[i];
    if (!count || !anchor) return;
    const type = s.type as PhotoSectionType;
    const title = typeof s.content.title === "string" && type !== "hero" ? s.content.title.trim() : "";
    const base = `${SECTION_LABEL[type]}${title ? ` «${title.slice(0, 60)}»` : ""}`;
    for (let n = 1; n <= count; n++)
      out.push({
        slot: n === 1 ? anchor : `${anchor}-${n}`,
        sectionIndex: i,
        type,
        n,
        label: count > 1 ? `${base}, фото ${n}` : base,
        orientation: orientationOf(type, n, s.variant),
      });
  });
  // The first screen and the story first, then the rest in page order.
  const rank = (t: PhotoSectionType) => (t === "hero" ? 0 : t === "about" ? 1 : 2);
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x.type) - rank(b.x.type) || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ x }) => x);
}

/** Stock photos of the plan by slot (only slots the current sections still have). */
export function stockBySlot(plan: Pick<SystemPlan, "landing" | "design">): Map<string, PlanPhoto> {
  const slots = new Set(photoSlots(plan).map((s) => s.slot));
  return new Map((plan.design.photos ?? []).filter((p) => slots.has(p.slot)).map((p) => [p.slot, p]));
}

/** Address of a width variant of a library photo. */
export const photoSrc = (file: string, width: number): string => `${PHOTO_LIBRARY_PATH}/${file}/${width}`;

/** Expression of the picture of a slot in a landing page (the hook of SitePhotos.tsx). */
export const photoExpr = (slot: string): string => `photo(${js(slot)})`;

/** ui/pages/SitePhotos.tsx: slots, stock photos and the hooks the landing, the credits and the cabinet pages share. */
export function sitePhotosFile(ctx: GenContext): string {
  const on = ctx.params.photos === true;
  const slots = on ? photoSlots(ctx.plan).map((s) => ({ slot: s.slot, label: s.label })) : [];
  const stock = on
    ? Object.fromEntries(
        [...stockBySlot(ctx.plan).values()].map((p) => [
          p.slot,
          {
            file: p.file,
            alt: p.alt,
            provider: PROVIDER_LABEL[p.provider],
            author: p.author,
            ...(p.authorUrl ? { authorUrl: p.authorUrl } : {}),
            pageUrl: p.pageUrl,
            license: p.license,
            licenseUrl: p.licenseUrl,
          },
        ]),
      )
    : {};
  const owner = on
    ? [
        "",
        "/** The owner's photos (site_photo rows) by slot; a replaced slot shows the owner's picture. */",
        "export function useOwnerPhotos(): { rows: Map<string, Rec>; loading: boolean; refetch(): void } {",
        `  const list = useDataSource().useList(${js(SITE_PHOTO.entity)}, { pageSize: 50 });`,
        "  const rows = new Map<string, Rec>();",
        `  for (const r of list.data?.items ?? []) if (typeof r.${SITE_PHOTO.slot} === "string" && typeof r.${SITE_PHOTO.image} === "string") rows.set(r.${SITE_PHOTO.slot}, r);`,
        "  return { rows, loading: list.isLoading, refetch: list.refetch };",
        "}",
        "",
        "/** Picture of a slot: the owner's photo, else the stock photo; undefined — the theme graphic. */",
        "export function useSitePhotos(): (slot: string) => ImageSource | undefined {",
        "  const { rows } = useOwnerPhotos();",
        "  return (slot) => {",
        "    const r = rows.get(slot);",
        `    if (r && typeof r.${SITE_PHOTO.image} === "string")`,
        `      return { fileId: r.${SITE_PHOTO.image}, alt: typeof r.${SITE_PHOTO.alt} === "string" && r.${SITE_PHOTO.alt} ? r.${SITE_PHOTO.alt} : labelOf(slot) };`,
        "    return stockImage(slot);",
        "  };",
        "}",
      ]
    : [];
  return [
    "// Generated by the landing module (B2-38): photo slots of the landing, stock photos of the plan (copies in the",
    "// platform photo library with their source, author and licence) and the owner's photos that replace them.",
    `import { type ImageSource${on ? ", type Rec, useDataSource" : ""} } from "@wizard/ui-kit";`,
    "",
    "export interface StockPhoto {",
    "  file: string;",
    "  alt: string;",
    "  provider: string;",
    "  author: string;",
    "  authorUrl?: string;",
    "  pageUrl: string;",
    "  license: string;",
    "  licenseUrl: string;",
    "}",
    "",
    "/** Places of the landing that show a picture, in page order. */",
    `export const SLOTS: readonly { slot: string; label: string }[] = ${js(slots)};`,
    "/** Stock photos by slot. */",
    `export const STOCK: Readonly<Record<string, StockPhoto>> = ${js(stock)};`,
    `const WIDTHS = ${js(PHOTO_WIDTHS)};`,
    `const src = (file: string, width: number) => ${js(`${PHOTO_LIBRARY_PATH}/`)} + file + "/" + width;`,
    "",
    'export const labelOf = (slot: string): string => SLOTS.find((s) => s.slot === slot)?.label ?? "Фото";',
    "",
    "/** The stock photo of a slot as a picture with width variants. */",
    "export function stockImage(slot: string): ImageSource | undefined {",
    "  const p = STOCK[slot];",
    "  if (!p) return undefined;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of generated TSX, not a template
    '  return { src: src(p.file, 960), srcSet: WIDTHS.map((w) => `${src(p.file, w)} ${w}w`).join(", "), alt: p.alt };',
    "}",
    "",
    "/** Pictures that exist (a collage takes only those). */",
    "export const somePhotos = (xs: readonly (ImageSource | undefined)[]): ImageSource[] =>",
    "  xs.filter((x): x is ImageSource => x !== undefined);",
    ...owner,
    "",
  ].join("\n");
}

/** «Источники фото» (public): where every stock photo of the page comes from, its author and licence. */
export function photoCreditsPage(_ctx: ScreenContext): string {
  return [
    "// Generated by the landing module (B2-38): sources of the stock photos — stock, author, photo page and licence.",
    'import { LandingSection } from "@wizard/ui-kit";',
    `import { STOCK, SLOTS, useOwnerPhotos } from ${js(PHOTO_HELPER.importFrom)};`,
    "",
    "export default function PhotoCredits() {",
    "  const { rows } = useOwnerPhotos();",
    "  const used = SLOTS.filter((s) => STOCK[s.slot] && !rows.has(s.slot));",
    "  return (",
    '    <LandingSection title="Источники фото" main intro="Фото на этом сайте взяты со свободных фотостоков с разрешением на коммерческое использование. Копии хранятся у нас.">',
    "      {used.length === 0 ? (",
    "        <p>Сейчас на сайте нет фото со стоков.</p>",
    "      ) : (",
    '        <ul data-testid="wz-photo-credits">',
    "          {used.map((s) => {",
    "            const p = STOCK[s.slot]!;",
    "            return (",
    "              <li key={s.slot}>",
    '                <strong>{s.label}</strong>: фото{" "}',
    '                {p.authorUrl ? <a href={p.authorUrl} rel="noopener noreferrer">{p.author}</a> : p.author}',
    '                {" "}на <a href={p.pageUrl} rel="noopener noreferrer">{p.provider}</a>, лицензия{" "}',
    '                <a href={p.licenseUrl} rel="noopener noreferrer">{p.license}</a>',
    "              </li>",
    "            );",
    "          })}",
    "        </ul>",
    "      )}",
    '      <p><a href="/">На главную</a></p>',
    "    </LandingSection>",
    "  );",
    "}",
    "",
  ].join("\n");
}

/** «Фото сайта» (owner): every picture of the landing with «Загрузить своё фото» — one click replaces it. */
export function photoCabinetPage(_ctx: ScreenContext): string {
  const e = js(SITE_PHOTO.entity);
  return [
    "// Generated by the landing module (B2-38): photos of the site; the owner replaces any of them with their own in one",
    "// click (an image upload saves the slot's row), «Удалить» brings back the stock photo or the theme graphic.",
    'import { useState } from "@wizard/sdk";',
    'import { CabinetLayout, Image, ImageField, useDataSource } from "@wizard/ui-kit";',
    `import { SLOTS, STOCK, stockImage, useOwnerPhotos } from ${js(PHOTO_HELPER.importFrom)};`,
    "",
    "export default function SitePhotos() {",
    "  const { rows, refetch } = useOwnerPhotos();",
    "  const data = useDataSource();",
    `  const create = data.useCreate(${e});`,
    `  const update = data.useUpdate(${e});`,
    `  const remove = data.useRemove(${e});`,
    "  const [problem, setProblem] = useState<string | undefined>();",
    "  const save = async (slot: string, label: string, fileId: string | null) => {",
    "    setProblem(undefined);",
    "    const row = rows.get(slot);",
    "    try {",
    "      if (fileId === null) {",
    "        if (row) await remove.mutate(row.id);",
    `      } else if (row) await update.mutate(row.id, { ${SITE_PHOTO.image}: fileId });`,
    `      else await create.mutate({ ${SITE_PHOTO.slot}: slot, ${SITE_PHOTO.image}: fileId, ${SITE_PHOTO.alt}: label });`,
    "      refetch();",
    "    } catch {",
    '      setProblem("Не удалось сохранить фото — попробуйте ещё раз.");',
    "    }",
    "  };",
    "  const content = (",
    "    <div>",
    "      <p>Нажмите «Загрузить своё фото» у нужного места — фото сразу появится на сайте. «Удалить» вернёт фото со стока или графику оформления.</p>",
    '      {problem && <p role="alert">{problem}</p>}',
    "      {SLOTS.length === 0 ? (",
    "        <p>На странице сейчас нет мест для фото: в разделах сайта нет первого экрана с картинкой, галереи или блока «О нас» с фото.</p>",
    "      ) : (",
    '        <ul data-testid="wz-site-photos">',
    "          {SLOTS.map((s) => {",
    "            const row = rows.get(s.slot);",
    `            const own = typeof row?.${SITE_PHOTO.image} === "string" ? (row.${SITE_PHOTO.image} as string) : null;`,
    "            const stock = STOCK[s.slot];",
    "            const pic = own ? undefined : stockImage(s.slot);",
    "            return (",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of generated TSX, not a template
    "              <li key={s.slot} data-testid={`wz-site-photo-${s.slot}`}>",
    "                <h3>{s.label}</h3>",
    '                {pic && <Image {...pic} ratio="4/3" />}',
    "                <p>",
    "                  {own",
    '                    ? "Ваше фото."',
    "                    : stock",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of generated TSX, not a template
    "                      ? `Фото со стока ${stock.provider}, автор ${stock.author}.`",
    '                      : "Фото нет — на сайте графика оформления."}',
    "                </p>",
    "                <ImageField",
    `                  name=${js(SITE_PHOTO.image)}`,
    `                  entity=${e}`,
    '                  label={own ? "Заменить своим фото" : "Загрузить своё фото"}',
    "                  value={own}",
    "                  onChange={(id) => void save(s.slot, s.label, id)}",
    "                />",
    "              </li>",
    "            );",
    "          })}",
    "        </ul>",
    "      )}",
    "    </div>",
    "  );",
    "  return (",
    '    <CabinetLayout title="Фото сайта" defaultSection="photos" sections={[{ id: "photos", label: "Фото на странице", content }]} />',
    "  );",
    "}",
    "",
  ].join("\n");
}
