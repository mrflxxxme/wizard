// A live first screen of a direction (V3-09): a one-page system — ui/design.css of its design system, the header and
// hero patterns copied from the library (C3) and a page that renders them with the client's texts. The caller builds
// it with buildSystem like any v3 system. Photos are placeholders of the platform (the stock search runs at «Собрать»).
import type { AppSpec } from "@wizard/appspec";
import { type DesignSystemV3, designSystemCss } from "@wizard/ui-kit/v3/design";
import { hash32, patternById, patternFiles } from "@wizard/ui-kit/v3/patterns";
import type { DirectionTexts } from "./texts.js";

export const PREVIEW_PAGE_FILE = "ui/pages/Preview.tsx";
/**
 * Routes of the preview page: "/" when served at an origin, "/srcdoc" when the platform shows it in an
 * <iframe srcdoc> (location.pathname of about:srcdoc is «srcdoc»).
 */
export const PREVIEW_ROUTES = ["/", "/srcdoc"] as const;

export interface PreviewPaths {
  /** Where the woff2 files of the design system are served (ends with «/»). */
  fontBase: string;
  /** Where placeholder photos are served (ends with «/»); same-origin path (imageSlot). */
  photoBase: string;
}

export interface PreviewContent {
  /** Business name in the header. */
  name: string;
  nav: readonly { label: string; href: string }[];
  texts: DirectionTexts;
  /** Show photos on the first screen (the hero pattern decides whether it has a place for one). */
  photos: boolean;
}

export interface PreviewSystem {
  spec: AppSpec;
  files: Map<string, string>;
}

const pascal = (id: string) => id.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase());
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Name of a placeholder photo of a direction (letters, digits and dashes). */
export const photoName = (archetype: string, n: number, k: number) =>
  `${archetype.replace(/_/g, "-")}-${n}-${k}.svg`;

/** Props of the hero pattern: texts, an anchor action and placeholder photos where the pattern has a place. */
function heroProps(
  heroId: string,
  ds: DesignSystemV3,
  n: number,
  c: PreviewContent,
  paths: PreviewPaths,
): Record<string, unknown> {
  const alt = clip(`Место для фото: ${ds.imagery.style}`, 200);
  const image = (k: number) => ({ src: `${paths.photoBase}${photoName(ds.archetype, n, k)}`, alt });
  const props: Record<string, unknown> = {
    title: c.texts.title,
    ...(c.texts.lead ? { lead: c.texts.lead } : {}),
    action: { label: c.texts.action, href: "#form" },
  };
  if (c.photos && heroId !== "hero-typographic") {
    props.image = image(1);
    if (heroId === "hero-collage") props.images = [image(1), image(2), image(3)];
  }
  return props;
}

/** The one-page system of a direction's first screen (validated by the patterns' slot schemas). */
export function directionPreview(
  d: { n: number; header: string; hero: string; design: DesignSystemV3 },
  c: PreviewContent,
  paths: PreviewPaths,
): PreviewSystem {
  const header = patternById(d.header);
  const hero = patternById(d.hero);
  if (!header || !hero) throw new Error(`unknown pattern ${header ? d.hero : d.header}`);
  const headerProps = header.slots.parse({
    brand: { name: clip(c.name || "Ваш бизнес", 60), href: "#top" },
    nav: c.nav.slice(0, 6),
    action: { label: c.texts.action, href: "#form" },
  });
  const heroValues = hero.slots.parse(heroProps(hero.id, d.design, d.n, c, paths));
  const page = [
    `import ${pascal(header.id)} from "../patterns/${header.id}";`,
    `import ${pascal(hero.id)} from "../patterns/${hero.id}";`,
    "",
    "export default function Preview() {",
    "  return (",
    `    <div id="top" data-direction="${d.n}" className="min-h-screen bg-background text-foreground">`,
    `      <${pascal(header.id)} {...${JSON.stringify(headerProps)}} />`,
    "      <main>",
    `        <${pascal(hero.id)} {...${JSON.stringify(heroValues)}} />`,
    "      </main>",
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n");
  const files = new Map<string, string>([
    [
      "ui/design.css",
      [
        designSystemCss(d.design, { fonts: true, fontBase: paths.fontBase }),
        "html { background-color: var(--color-background); color: var(--color-foreground); font-family: var(--font-sans); }",
        "",
      ].join("\n"),
    ],
    ...patternFiles([header.id, hero.id]),
    [PREVIEW_PAGE_FILE, page],
  ]);
  const spec: AppSpec = {
    specVersion: "1",
    app: { name: clip(c.name || "Превью", 80), locale: "ru" },
    entities: [],
    roles: [{ name: "visitor", label: "Посетитель", access: "public" }],
    permissions: [],
    pages: PREVIEW_ROUTES.map((route) => ({
      route,
      title: "Первый экран",
      file: PREVIEW_PAGE_FILE,
      roles: ["visitor"],
    })),
  } as unknown as AppSpec;
  return { spec, files };
}

/** A placeholder photo: a soft two-tone gradient with a shape, its hue from the name (no network, no text). */
export function previewPhotoSvg(name: string): string {
  const h = hash32(name) % 360;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 22% 80%)"/>` +
    `<stop offset="1" stop-color="hsl(${(h + 35) % 360} 18% 38%)"/></linearGradient></defs>` +
    `<rect width="1600" height="1200" fill="url(#g)"/><circle cx="1080" cy="520" r="290" fill="hsl(${h} 16% 90%)" opacity="0.7"/>` +
    `<rect x="260" y="760" width="620" height="180" rx="24" fill="hsl(${(h + 35) % 360} 14% 92%)" opacity="0.45"/></svg>`
  );
}
