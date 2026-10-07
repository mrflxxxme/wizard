// The catalog showcase (page /services and the landing section «Услуги из каталога»): visible items sorted by the
// owner's order, in a ui-kit LandingSection like every other section (B2-35). With somewhere to go — the booking page or
// the landing's lead form — items are cards (ui-kit Catalog) whose «Выбрать» leads there; without it the showcase is a
// price list (DataTable), as in the D75 site template. Layout tabs: filter buttons by catalog section (with_categories),
// without sections — cards.
import { sectionAnchors } from "../landing/page.js";
import { js } from "../screens/jsx.js";
import type { ModuleContext, ScreenContext } from "../types.js";
import { catalogOptions, CATALOG_NAMES as N, SHOWCASE } from "./compile.js";

/** Where «Выбрать» on an item leads: booking of the item, else the lead form on the landing; none — a price list. */
export type ShowcaseTarget = { kind: "booking"; prefix: string } | { kind: "lead"; href: string };

export function showcaseTarget(ctx: ModuleContext): ShowcaseTarget | undefined {
  if (ctx.present.has("booking")) return { kind: "booking", prefix: "/booking?service=" };
  if (!ctx.present.has("leads") || !ctx.present.has("landing")) return undefined;
  const sections = ctx.plan.landing?.sections ?? [];
  const i = sections.findIndex((s) => s.type === "lead_form");
  const anchor = i >= 0 ? sectionAnchors(sections)[i] : undefined;
  return anchor ? { kind: "lead", href: `/#${anchor}` } : undefined;
}

/** Columns of the price list: name, category, duration, price (when shown) and description. */
export function priceListColumns(params: Readonly<Record<string, unknown>>): string[] {
  const o = catalogOptions(params);
  return [
    N.title,
    ...(o.withCategories ? [N.categoryRef] : []),
    ...(o.withDuration ? [N.duration] : []),
    ...(o.showPrices ? [N.price] : []),
    N.description,
  ];
}

const EMPTY = "Скоро здесь появятся позиции каталога";

/** TSX of ui/pages/CatalogServices.tsx: ServiceShowcase (shared with the landing) and the page itself. */
export function catalogShowcasePage(ctx: ScreenContext): string {
  const o = catalogOptions(ctx.params);
  const target = showcaseTarget(ctx);
  const query = `{ filter: { ${N.active}: true }, sort: { field: ${js(N.sortOrder)}, dir: "asc" as const } }`;
  const table = `<DataTable entity=${js(N.item)} columns={${js(priceListColumns(ctx.params))}} query={QUERY} emptyText=${js(EMPTY)} />`;
  const booking = target?.kind === "booking";
  const tabs = !!target && o.withCategories;
  const imports = target
    ? [
        "Catalog",
        "DataTable",
        "LandingSection",
        "type Rec",
        ...(o.withPhotos || o.withCategories ? ["useDataSource"] : []),
        ...(booking ? ["useNavigate"] : []),
      ]
    : ["DataTable", "LandingSection"];
  const hooks: string[] = [];
  let body: string[];
  if (target) {
    if (o.withPhotos) hooks.push("  const files = useDataSource().useFiles();");
    if (o.withCategories)
      hooks.push(
        `  const categories = useDataSource().useList(${js(N.category)}, { pageSize: 100 });`,
        `  const categoryName = (id: unknown) => text(categories.data?.items.find((c) => c.id === id)?.${N.title});`,
      );
    if (booking) hooks.push("  const navigate = useNavigate();");
    if (tabs)
      hooks.push(
        "  const [tab, setTab] = useState<string | null>(null);",
        '  const tabs = props.layout === "tabs"',
        `    ? [{ id: null, label: "Все" }, ...(categories.data?.items ?? []).map((c) => ({ id: c.id, label: text(c.${N.title}) ?? "—" }))]`,
        "    : undefined;",
        `  const query = tab ? { ...QUERY, filter: { ...QUERY.filter, ${N.categoryRef}: tab } } : QUERY;`,
      );
    // The lead form is a section of «/»: a real navigation lets the browser scroll to its anchor.
    const select =
      target.kind === "booking"
        ? `(r: Rec) => navigate(${js(target.prefix)} + encodeURIComponent(r.id))`
        : `() => location.assign(${js(target.href)})`;
    const minutes = o.withDuration
      ? `typeof r.${N.duration} === "number" ? \`\${r.${N.duration}} мин\` : undefined, `
      : "";
    const card = [
      "id: r.id,",
      `title: text(r.${N.title}) ?? "Без названия",`,
      `description: [${minutes}text(r.${N.description})].filter(Boolean).join(" · ") || undefined,`,
      ...(o.withPhotos
        ? [`image: typeof r.${N.photo} === "string" ? files.imageSrc(r.${N.photo}, 480) : undefined,`]
        : []),
      ...(o.showPrices
        ? [`price: typeof r.${N.price} === "number" ? r.${N.price} : null,`, 'priceText: "Цена по запросу",']
        : []),
      ...(o.withCategories
        ? ['badge: category ? { text: category, tone: "neutral" as const } : undefined,']
        : []),
    ];
    body = [
      '      {props.layout === "table" ? (',
      `        ${table}`,
      "      ) : (",
      "        <Catalog",
      `          entity=${js(N.item)}`,
      `          query={${tabs ? "query" : "QUERY"}}`,
      '          columns={props.layout === "list" ? 1 : "auto"}',
      "          map={(r: Rec) => {",
      ...(o.withCategories ? [`            const category = categoryName(r.${N.categoryRef});`] : []),
      "            return {",
      ...card.map((l) => `              ${l}`),
      "            };",
      "          }}",
      `          onSelect={${select}}`,
      `          emptyText=${js(EMPTY)}`,
      "        />",
      "      )}",
    ];
  } else body = [`      ${table}`];
  return [
    "// Generated by the catalog module (B2-13): the showcase of visible catalog items — this page and the landing",
    "// section «Услуги из каталога» (ServiceShowcase).",
    ...(tabs ? ['import { useState } from "@wizard/sdk";'] : []),
    `import { ${imports.join(", ")} } from "@wizard/ui-kit";`,
    "",
    "export interface ServiceShowcaseProps {",
    "  title: string;",
    "  intro?: string;",
    "  anchor?: string;",
    '  layout?: "cards" | "list" | "table" | "tabs";',
    "  /** Rhythm band of the landing. */",
    '  tone?: "alt";',
    "  /** The page's main heading (h1); on the landing — a section heading (h2). */",
    "  main?: boolean;",
    "}",
    "",
    `const QUERY = ${query};`,
    ...(target
      ? [
          'const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);',
        ]
      : []),
    "",
    `export function ${SHOWCASE.component}(props: ServiceShowcaseProps) {`,
    ...hooks,
    "  return (",
    "    <LandingSection",
    "      title={props.title}",
    "      intro={props.intro}",
    "      anchor={props.anchor}",
    "      tone={props.tone}",
    "      main={props.main}",
    ...(tabs ? ["      tabs={tabs}", "      tab={tab}", "      onTab={setTab}"] : []),
    "    >",
    ...body,
    "    </LandingSection>",
    "  );",
    "}",
    "",
    "export default function CatalogServices() {",
    `  return <${SHOWCASE.component} title={${js(o.showcaseTitle)}} main layout="cards" />;`,
    "}",
    "",
  ].join("\n");
}
