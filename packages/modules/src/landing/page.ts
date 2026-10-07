// Landing page «/» from the plan's sections (specs/modules/modules.yaml#sections, #compile.order step 6): each section
// becomes a ui-kit block of the section library (B2-35) with the plan's variant and texts. Every variant of
// SECTION_CATALOG has a renderer; the engine still rejects a variant outside `ready` (SECTION_NOT_IMPLEMENTED) for
// catalogs extended later. Sections with data (services, pricing, lead form) read the entities of their modules.
import type { PlanSection } from "@wizard/appspec";
import { CATALOG_NAMES, SHOWCASE } from "../catalog/compile.js";
import { PACKAGE_NAMES } from "../packages/compile.js";
import { homeActions, staffSignIn } from "../screens/home.js";
import { fragmentPage, type JsxAttr, js, jsxEl } from "../screens/jsx.js";
import type { ScreenContext } from "../types.js";
import {
  GALLERY_TILES,
  PHOTO_CREDITS_ROUTE,
  PHOTO_HELPER,
  PROVIDER_LABEL,
  photoExpr,
  photoSlots,
  stockBySlot,
} from "./photos.js";

type Link = { label: string; href: string };
type Content = PlanSection["content"];
type Item = string | Record<string, string>;

/** Canonical entity of a section bound to data (owned by the module the section needs). */
export const SECTION_ENTITY: Readonly<Record<string, string>> = { lead_form: "lead", services: "service" };

/** Section components and helpers that live in another generated file, by the module they are imported from. */
const LOCAL_BLOCKS: Readonly<Record<string, string>> = {
  [SHOWCASE.component]: SHOWCASE.importFrom,
  useSitePhotos: PHOTO_HELPER.importFrom,
  somePhotos: PHOTO_HELPER.importFrom,
};

const DEFAULT_ANCHOR: Readonly<Record<string, string>> = {
  hero: "top",
  features: "features",
  steps: "steps",
  faq: "faq",
  cta: "cta",
  lead_form: "lead",
  pricing: "prices",
  booking: "booking",
  gallery: "gallery",
  team: "team",
  testimonials: "reviews",
  stats: "stats",
  about: "about",
  contacts: "contacts",
  hours: "hours",
  logos: "partners",
  text: "text",
};
/** Sections the main call to action leads to, in priority order. */
const TARGETS = ["lead_form", "booking"];
/** Page of the booking module (slot picker). */
const BOOKING_ROUTE = "/booking";
/** Tiles of a gallery without items: a stock photo or the owner's photo per tile, else the theme graphic (B2-38). */
const GALLERY_PLACEHOLDERS = GALLERY_TILES;

const str = (c: Content, k: string): string | undefined => {
  const v = c[k];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};
const list = (c: Content, k: string): Item[] => {
  const v = c[k];
  return Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : [];
};
const val = (it: Record<string, string>, ...keys: string[]): string | undefined =>
  keys.map((k) => it[k]?.trim()).find((v) => !!v);
/** Items of a section as objects: a plain string fills `first`; an item without its `need` keys is dropped. */
function items(c: Content, first: string, need: readonly string[] = [first]): Record<string, string>[] {
  return list(c, "items").flatMap((it) => {
    const o = typeof it === "string" ? { [first]: it } : it;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (v?.trim()) out[k] = v.trim();
    return need.every((k) => out[k]) ? [out] : [];
  });
}
/** «Пн–Пт: 10:00–20:00» or «12 лет — опыт» → two parts at the first separator. */
function split(text: string, seps: readonly string[]): [string, string] | undefined {
  for (const sep of seps) {
    const i = text.indexOf(sep);
    if (i > 0 && i + sep.length < text.length)
      return [text.slice(0, i).trim(), text.slice(i + sep.length).trim()];
  }
  return undefined;
}
const pairs = (c: Content, a: string, b: string, seps: readonly string[]) =>
  list(c, "items").flatMap((it) => {
    if (typeof it !== "string") {
      const x = it[a]?.trim();
      const y = it[b]?.trim();
      return x && y ? [{ [a]: x, [b]: y }] : [];
    }
    const p = split(it, seps);
    return p ? [{ [a]: p[0], [b]: p[1] }] : [];
  });
/** Plain strings of a list (undefined when there are none, so the attribute is omitted). */
const strings = (xs: Item[]): string[] | undefined => {
  const out = xs.filter((m): m is string => typeof m === "string");
  return out.length ? out : undefined;
};
/** Items {title, text?} from strings or objects with title/text. */
const titled = (c: Content) =>
  items(c, "title").map((o) => ({ title: o.title as string, ...(o.text ? { text: o.text } : {}) }));
const qa = (c: Content) =>
  list(c, "items").flatMap((it) =>
    typeof it !== "string" && it.question && it.answer ? [{ question: it.question, answer: it.answer }] : [],
  );

/** Anchors of the sections: the plan's, else a default per type; repeated types get _2, _3. */
export function sectionAnchors(sections: readonly PlanSection[]): (string | undefined)[] {
  const used = new Map<string, number>();
  return sections.map((s) => {
    const base =
      s.anchor ?? DEFAULT_ANCHOR[s.type] ?? (s.type === "header" || s.type === "footer" ? "" : s.type);
    if (!base) return undefined;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

type Render = (s: PlanSection, anchor: string | undefined, env: Env) => [component: string, attrs: JsxAttr[]];
interface Env {
  brand: string;
  links: Link[];
  target: string | undefined;
  /** The team's sign-in «Войти» of a landing with nothing for the public to do (B2-49), else undefined. */
  signIn: Link | undefined;
  sticky: boolean;
  /** Tone of the section (rhythm: every second body section on the alternate band). */
  tone: "alt" | undefined;
  ctx: ScreenContext;
  /** Expression of the n-th picture of the section (B2-38 photo slot), undefined — no slot (theme graphic). */
  photo: (n: number) => string | undefined;
  /** Footer: stock providers of the page's photos (a link to «Источники фото»). */
  stock: readonly string[];
}

/** Items with the section's photo slots: `{...item, image: photo("gallery-2")}` (an expression), else the JSON. */
function withPhotos(list: readonly Record<string, unknown>[], env: Env): string | undefined {
  if (!list.some((_, i) => env.photo(i + 1))) return undefined;
  return `[${list
    .map((it, i) => {
      const e = env.photo(i + 1);
      return e ? `{ ...${js(it)}, image: ${e} }` : js(it);
    })
    .join(", ")}]`;
}

const action = (label: string | undefined, env: Env): Link | undefined =>
  label && env.target ? { label, href: env.target } : undefined;
const base = (s: PlanSection, a: string | undefined, env: Env): JsxAttr[] => [
  ["variant", s.variant, "lit"],
  ["anchor", a, "lit"],
  ["tone", env.tone, "lit"],
];

/** Data of the pricing section: catalog services when the plan has the catalog, else the tariffs of packages. */
function pricingSource(env: Env): JsxAttr[] {
  const { ctx } = env;
  const query = (active: string, sort?: string) => ({
    filter: { [active]: true },
    ...(sort ? { sort: { field: sort, dir: "asc" } } : {}),
  });
  if (ctx.present.has("catalog")) {
    const p = ctx.allParams.catalog ?? {};
    return [
      ["entity", CATALOG_NAMES.item],
      ["nameField", CATALOG_NAMES.title],
      ["priceField", CATALOG_NAMES.price],
      ["descriptionField", CATALOG_NAMES.description],
      ["details", p.with_duration === true ? [{ field: CATALOG_NAMES.duration, suffix: "мин" }] : undefined],
      ["query", query(CATALOG_NAMES.active, CATALOG_NAMES.sortOrder)],
    ];
  }
  const kind = ctx.allParams.packages?.kind;
  return [
    ["entity", PACKAGE_NAMES.plan],
    ["nameField", "name"],
    ["priceField", "price"],
    ["descriptionField", "description"],
    [
      "details",
      [
        ...(kind !== "period" ? [{ field: "visits", suffix: "визитов" }] : []),
        ...(kind !== "visits" ? [{ field: "days", suffix: "дней" }] : []),
      ],
    ],
    ["query", query("active")],
  ];
}

/** Block renderers by section type; every variant of SECTION_CATALOG is a prop value of its block. */
export const SECTION_RENDERERS: Readonly<Record<string, Render>> = {
  header: (s, _a, env) => [
    "Header",
    [
      ["brand", env.brand],
      ["links", env.links.length ? env.links : undefined],
      ["cta", env.signIn ?? action(str(s.content, "cta"), env)],
      ["variant", s.variant, "lit"],
      ["sticky", env.sticky],
    ],
  ],
  hero: (s, a, env) => [
    "Hero",
    [
      ["title", str(s.content, "title")],
      ["subtitle", str(s.content, "subtitle")],
      ["eyebrow", str(s.content, "eyebrow")],
      ["primary", env.signIn ?? action(str(s.content, "cta"), env)],
      ["image", env.photo(1), "expr"],
      [
        "images",
        s.variant === "collage" && (env.photo(2) || env.photo(3))
          ? `somePhotos([${[env.photo(2), env.photo(3)].filter(Boolean).join(", ")}])`
          : undefined,
        "expr",
      ],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  features: (s, a, env) => {
    const its = titled(s.content);
    const pics = s.variant === "alternating" ? withPhotos(its, env) : undefined;
    return [
      "Features",
      [
        ["title", str(s.content, "title")],
        ["intro", str(s.content, "intro")],
        pics ? ["items", pics, "expr"] : ["items", its],
        ...base(s, a, env),
      ],
    ];
  },
  steps: (s, a, env) => [
    "Steps",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["steps", titled(s.content)],
      ...base(s, a, env),
    ],
  ],
  faq: (s, a, env) => [
    "Faq",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["items", qa(s.content)],
      ...base(s, a, env),
    ],
  ],
  cta: (s, a, env) => [
    "Cta",
    [
      ["title", str(s.content, "title")],
      ["text", str(s.content, "text")],
      ["action", env.signIn ?? { label: str(s.content, "cta") ?? "", href: env.target ?? "/" }],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  lead_form: (s, a, env) => [
    "LeadForm",
    [
      ["entity", SECTION_ENTITY.lead_form],
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["submitLabel", str(s.content, "submit_label")],
      ...base(s, a, env),
    ],
  ],
  // The catalog module's showcase (ui/pages/CatalogServices.tsx): variant → layout (list | cards | table | tabs).
  services: (s, a, env) => [
    SHOWCASE.component,
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["anchor", a, "lit"],
      ["layout", s.variant, "lit"],
      ["tone", env.tone, "lit"],
    ],
  ],
  pricing: (s, a, env) => [
    "Pricing",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["note", str(s.content, "note")],
      ...pricingSource(env),
      [
        "action",
        env.ctx.present.has("booking")
          ? { label: "Записаться", href: BOOKING_ROUTE }
          : env.target
            ? { label: "Оставить заявку", href: env.target }
            : undefined,
      ],
      ...base(s, a, env),
    ],
  ],
  booking: (s, a, env) => [
    "Booking",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["action", { label: str(s.content, "cta") ?? "Выбрать время", href: BOOKING_ROUTE }],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
      ["tone", env.tone, "lit"],
    ],
  ],
  gallery: (s, a, env) => {
    const its = items(s.content, "caption", []).map((o) => (o.caption ? { caption: o.caption } : {}));
    const tiles = its.length ? its : Array.from({ length: GALLERY_PLACEHOLDERS }, () => ({}));
    const pics = withPhotos(tiles, env);
    return [
      "Gallery",
      [
        ["title", str(s.content, "title")],
        ["intro", str(s.content, "intro")],
        pics ? ["items", pics, "expr"] : ["items", tiles],
        ...base(s, a, env),
      ],
    ];
  },
  team: (s, a, env) => [
    "Team",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      [
        "items",
        items(s.content, "name").map((o) => ({
          name: o.name as string,
          ...(val(o, "role") ? { role: o.role } : {}),
          ...(val(o, "text") ? { text: o.text } : {}),
        })),
      ],
      ...base(s, a, env),
    ],
  ],
  testimonials: (s, a, env) => [
    "Testimonials",
    [
      ["title", str(s.content, "title")],
      [
        "items",
        items(s.content, "text").map((o) => ({
          text: o.text as string,
          ...(val(o, "author") ? { author: o.author } : {}),
          ...(val(o, "source") ? { source: o.source } : {}),
        })),
      ],
      ...base(s, a, env),
    ],
  ],
  stats: (s, a, env) => [
    "Stats",
    [
      ["title", str(s.content, "title")],
      ["items", pairs(s.content, "value", "label", [" — ", " – ", ": "])],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
      ["tone", s.variant === "band" ? undefined : env.tone, "lit"],
    ],
  ],
  about: (s, a, env) => [
    "About",
    [
      ["title", str(s.content, "title")],
      ["text", str(s.content, "text")],
      ["image", env.photo(1), "expr"],
      ...base(s, a, env),
    ],
  ],
  contacts: (s, a, env) => [
    "Contacts",
    [
      ["title", str(s.content, "title")],
      ["address", str(s.content, "address")],
      ["phone", str(s.content, "phone")],
      ["email", str(s.content, "email")],
      ["hours", str(s.content, "hours")],
      ["messengers", strings(list(s.content, "messengers"))],
      ...base(s, a, env),
    ],
  ],
  hours: (s, a, env) => [
    "Hours",
    [
      ["title", str(s.content, "title")],
      ["items", pairs(s.content, "day", "time", [": ", " — ", " – "])],
      ...base(s, a, env),
    ],
  ],
  logos: (s, a, env) => [
    "Logos",
    [
      ["title", str(s.content, "title")],
      ["items", items(s.content, "name").map((o) => ({ name: o.name as string }))],
      ...base(s, a, env),
    ],
  ],
  text: (s, a, env) => [
    "TextBlock",
    [["title", str(s.content, "title")], ["text", str(s.content, "text")], ...base(s, a, env)],
  ],
  // Stock photos on the page: a link to «Источники фото» (the minimal footer has no links — a line with the stocks).
  footer: (s, _a, env) => {
    const text = str(s.content, "text");
    const credit = env.stock.length ? `Фото: ${env.stock.join(", ")}.` : undefined;
    const minimal = s.variant === "minimal";
    return [
      "Footer",
      [
        ["brand", env.brand],
        ["text", minimal && credit ? [text, credit].filter(Boolean).join(" ") : text],
        [
          "columns",
          credit && !minimal
            ? [{ title: "Сайт", links: [{ label: "Источники фото", href: PHOTO_CREDITS_ROUTE }] }]
            : undefined,
        ],
        ["variant", s.variant, "lit"],
      ],
    ];
  },
};

/** Sections that keep their own background (no rhythm band): page edges and blocks on the brand colour. */
const OWN_TONE = new Set(["header", "hero", "footer", "cta"]);

/** Default band rhythm: every n-th body section on the alternate band (airy — fewer bands, more air). */
const BAND_EVERY = { airy: 3, balanced: 2, dense: 2 } as const;

/**
 * Bands of the landing sections (B2-37): null — the section keeps its own background (header, hero, cta, footer);
 * otherwise the section's band from the design direction, else every n-th body section by the rhythm.
 */
export function sectionBands(
  sections: readonly Pick<PlanSection, "type" | "band">[],
  rhythm: "airy" | "balanced" | "dense" | undefined,
): ("base" | "alt" | null)[] {
  const every = BAND_EVERY[rhythm ?? "balanced"];
  let body = 0;
  return sections.map((s) => {
    if (OWN_TONE.has(s.type)) return null;
    const nth = body++;
    return s.band ?? (nth % every === every - 1 ? "alt" : "base");
  });
}

/** Items of the header menu at most (B2-45: a short menu, the CTA button carries the main action). */
export const MAX_NAV_LINKS = 4;
/** Sections whose action leads to the call-to-action target: one menu item for all of them. */
const TARGET_GROUP = new Set([...TARGETS, "cta"]);
/** Function words a menu label is compared without. */
const NAV_STOP = new Set(
  "а в во для до за и из или к как ко мы на наш наша наше наши о об от по с со у ваш ваша ваше ваши вы".split(
    " ",
  ),
);
/** Letters of a word a menu label is compared by: «Записаться» and «Запишитесь» are one item («запи»). */
const STEM = 4;

/** Comparison key of a menu label: lowercase words without punctuation and function words, cut to their stems. */
export function navKey(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w && !NAV_STOP.has(w))
    .map((w) => w.slice(0, STEM));
}

/** Two labels name the same thing: their keys are equal, or the words of one are all in the other. */
export function sameNavLabel(a: string, b: string): boolean {
  const [x, y] = [navKey(a), navKey(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}

/**
 * Header menu of the landing (B2-45): the sections' titles as anchors, without the page edges; one item for the
 * sections leading to the call-to-action target (lead form, booking, call to action — the target section first);
 * no item repeating another one or the header button (navKey); at most MAX_NAV_LINKS.
 */
export function navLinks(
  sections: readonly PlanSection[],
  anchors: readonly (string | undefined)[],
  target: string | undefined,
  cta: string | undefined,
): Link[] {
  const candidates = sections.flatMap((s, i) => {
    const title = str(s.content, "title");
    const a = anchors[i];
    return title && a && !["header", "hero", "footer"].includes(s.type)
      ? [{ type: s.type, link: { label: title, href: `#${a}` } }]
      : [];
  });
  const group = candidates.filter((c) => TARGET_GROUP.has(c.type));
  const keep = group.find((c) => c.link.href === target) ?? group[0];
  const out: Link[] = [];
  for (const c of candidates) {
    if (TARGET_GROUP.has(c.type) && c !== keep) continue;
    if (cta && navKey(c.link.label).join(" ") === navKey(cta).join(" ")) continue;
    if (out.some((l) => sameNavLabel(l.label, c.link.label))) continue;
    out.push(c.link);
  }
  return out.slice(0, MAX_NAV_LINKS);
}

/** Label of the team's sign-in button on a back-office landing. */
export const SIGN_IN_LABEL = "Войти";

/**
 * The team's sign-in of a landing with nothing for the public to do (B2-49, D76 control measurement: a CRM landing had
 * the name, an empty header and a hero without a button): no call-to-action section (TARGETS) and no public action page
 * of the plan (booking, catalog, lead form, other public pages, the visitor's pages — homeActions). Undefined otherwise,
 * or when the pages of the system are unknown (a generator called outside the engine).
 */
export function landingSignIn(ctx: ScreenContext, target: string | undefined): Link | undefined {
  if (target || !ctx.site) return undefined;
  const { actions } = homeActions({
    spec: { ...ctx.spec, pages: [...ctx.site.pages] },
    present: ctx.present,
    params: ctx.allParams,
  });
  return actions.length ? undefined : { label: SIGN_IN_LABEL, href: staffSignIn(ctx.site.cabinet) };
}

/** TSX of the landing page: the plan's sections in order on ui-kit blocks. */
export function landingPage(ctx: ScreenContext): string {
  const sections = ctx.plan.landing?.sections ?? [];
  const anchors = sectionAnchors(sections);
  const targetIdx = TARGETS.map((t) => sections.findIndex((s) => s.type === t)).find((i) => i >= 0);
  const target = targetIdx !== undefined && anchors[targetIdx] ? `#${anchors[targetIdx]}` : undefined;
  const signIn = landingSignIn(ctx, target);
  const header = sections.find((s) => s.type === "header");
  const cta = signIn?.label ?? (header && target ? str(header.content, "cta") : undefined);
  const links = ctx.params.anchor_nav === true ? navLinks(sections, anchors, target, cta) : [];
  const imports: string[] = [];
  // Photo slots (B2-38): the owner's photo or the stock photo of the plan; without both — the theme graphic.
  const slots = ctx.params.photos === true ? photoSlots(ctx.plan) : [];
  const slotOf = new Map(slots.map((x) => [`${x.sectionIndex}:${x.n}`, x.slot]));
  const stock = [
    ...new Set([...stockBySlot(ctx.plan).values()].map((p) => PROVIDER_LABEL[p.provider])),
  ].sort();
  const bands = sectionBands(sections, ctx.plan.design.direction.rhythm);
  const blocks = sections.map((s, i) => {
    const render = SECTION_RENDERERS[s.type];
    if (!render) throw new Error(`no renderer for section ${s.type}`);
    const tone = bands[i] === "alt" ? "alt" : undefined;
    const env: Env = {
      brand: ctx.spec.app.name,
      links,
      target,
      signIn,
      sticky: ctx.params.sticky_header === true,
      tone,
      ctx,
      photo: (n) => {
        const slot = slotOf.get(`${i}:${n}`);
        return slot ? photoExpr(slot) : undefined;
      },
      stock: slots.length ? stock : [],
    };
    const [name, attrs] = render(s, anchors[i], env);
    imports.push(name);
    if (attrs.some(([k, v]) => k === "images" && v !== undefined)) imports.push("somePhotos");
    return jsxEl(name, attrs);
  });
  if (slots.length) imports.push("useSitePhotos");
  return fragmentPage(
    "// Generated by the landing module (B2-11, B2-35): sections and texts from the system plan, ui-kit blocks.",
    imports,
    blocks,
    LOCAL_BLOCKS,
    slots.length ? ["  const photo = useSitePhotos();"] : [],
  );
}
