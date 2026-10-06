// Landing page «/» from the plan's sections (specs/modules/modules.yaml#sections, #compile.order step 6): each section
// becomes a ui-kit block with the plan's variant and texts. Only variants marked ready in SECTION_CATALOG have a
// renderer; the engine rejects the others before compilation (SECTION_NOT_IMPLEMENTED, the rest come with B2-35).
import type { PlanSection } from "@wizard/appspec";
import { SHOWCASE } from "../catalog/compile.js";
import { fragmentPage, type JsxAttr, jsxEl } from "../screens/jsx.js";
import type { ScreenContext } from "../types.js";

type Link = { label: string; href: string };
type Content = PlanSection["content"];

/** Canonical entity of a section bound to data (owned by the module the section needs). */
export const SECTION_ENTITY: Readonly<Record<string, string>> = { lead_form: "lead", services: "service" };

/** Section components that live in another generated page, by the module they are imported from. */
const LOCAL_BLOCKS: Readonly<Record<string, string>> = { [SHOWCASE.component]: SHOWCASE.importFrom };

const DEFAULT_ANCHOR: Readonly<Record<string, string>> = {
  hero: "top",
  features: "features",
  steps: "steps",
  faq: "faq",
  cta: "cta",
  lead_form: "lead",
};
/** Sections the main call to action leads to, in priority order. */
const TARGETS = ["lead_form", "booking"];

const str = (c: Content, k: string): string | undefined => {
  const v = c[k];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};
const list = (c: Content, k: string): (string | Record<string, string>)[] => {
  const v = c[k];
  return Array.isArray(v) ? v : [];
};
/** Items {title, text?} from strings or objects with title/text. */
const titled = (c: Content, k: string) =>
  list(c, k).flatMap((it) => {
    if (typeof it === "string") return [{ title: it }];
    const title = it.title?.trim();
    return title ? [{ title, ...(it.text ? { text: it.text } : {}) }] : [];
  });
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
  sticky: boolean;
}

const action = (label: string | undefined, env: Env): Link | undefined =>
  label && env.target ? { label, href: env.target } : undefined;

/** Block renderers by section type; every ready variant of SECTION_CATALOG is a prop value of its block. */
export const SECTION_RENDERERS: Readonly<Record<string, Render>> = {
  header: (s, _a, env) => [
    "Header",
    [
      ["brand", env.brand],
      ["links", env.links.length ? env.links : undefined],
      ["cta", action(str(s.content, "cta"), env)],
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
      ["primary", action(str(s.content, "cta"), env)],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  features: (s, a) => [
    "Features",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["items", titled(s.content, "items")],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  steps: (s, a) => [
    "Steps",
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["steps", titled(s.content, "items")],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  faq: (s, a) => [
    "Faq",
    [
      ["title", str(s.content, "title")],
      ["items", qa(s.content)],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  cta: (s, a, env) => [
    "Cta",
    [
      ["title", str(s.content, "title")],
      ["text", str(s.content, "text")],
      ["action", { label: str(s.content, "cta") ?? "", href: env.target ?? "/" }],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  lead_form: (s, a) => [
    "LeadForm",
    [
      ["entity", SECTION_ENTITY.lead_form],
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["submitLabel", str(s.content, "submit_label")],
      ["variant", s.variant, "lit"],
      ["anchor", a, "lit"],
    ],
  ],
  // The catalog module's showcase (ui/pages/CatalogServices.tsx): variant → layout (list | cards | table).
  services: (s, a) => [
    SHOWCASE.component,
    [
      ["title", str(s.content, "title")],
      ["intro", str(s.content, "intro")],
      ["anchor", a, "lit"],
      ["layout", s.variant, "lit"],
    ],
  ],
  footer: (s, _a, env) => [
    "Footer",
    [
      ["brand", env.brand],
      ["text", str(s.content, "text")],
      ["variant", s.variant, "lit"],
    ],
  ],
};

/** TSX of the landing page: the plan's sections in order on ui-kit blocks. */
export function landingPage(ctx: ScreenContext): string {
  const sections = ctx.plan.landing?.sections ?? [];
  const anchors = sectionAnchors(sections);
  const targetIdx = TARGETS.map((t) => sections.findIndex((s) => s.type === t)).find((i) => i >= 0);
  const target = targetIdx !== undefined && anchors[targetIdx] ? `#${anchors[targetIdx]}` : undefined;
  const links: Link[] = [];
  if (ctx.params.anchor_nav === true)
    sections.forEach((s, i) => {
      const title = str(s.content, "title");
      const a = anchors[i];
      if (title && a && !["header", "hero", "footer"].includes(s.type))
        links.push({ label: title, href: `#${a}` });
    });
  const env: Env = {
    brand: ctx.spec.app.name,
    links: links.slice(0, 6),
    target,
    sticky: ctx.params.sticky_header === true,
  };
  const imports: string[] = [];
  const blocks = sections.map((s, i) => {
    const render = SECTION_RENDERERS[s.type];
    if (!render) throw new Error(`no renderer for section ${s.type}`);
    const [name, attrs] = render(s, anchors[i], env);
    imports.push(name);
    return jsxEl(name, attrs);
  });
  return fragmentPage(
    "// Generated by the landing module (B2-11): sections and texts from the system plan, ui-kit blocks.",
    imports,
    blocks,
    LOCAL_BLOCKS,
  );
}
