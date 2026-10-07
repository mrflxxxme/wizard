// Home page «/» of a system without the landing module (B2-45, after the D76 measurement): not an empty canvas with one
// cabinet button. With something for the public to do (booking, the catalog, a lead form, the visitor cabinet) — a
// short public home: the name, one line from the plan, the public actions as buttons and the menu, the blocks the
// visitor needs (how booking works, the catalog showcase, the lead form) and the owner's sign-in as a quiet footer
// link. A back-office-only system (CRM, resources) — a staff sign-in page: the name, «Рабочее пространство», «Войти».
import type { AppSpec, Page } from "@wizard/appspec";
import { catalogOptions, SHOWCASE } from "../catalog/compile.js";
import { PHOTO_CREDITS_ROUTE } from "../landing/photos.js";
import { fragmentPage, type JsxAttr, jsxEl } from "./jsx.js";

type Link = { label: string; href: string };

/** Booking page of the booking module (slot picker). */
const BOOKING_ROUTE = "/booking";
/** Anchor of the lead form on the home page (the catalog's «Выбрать» leads to `/#lead`). */
export const HOME_LEAD_ANCHOR = "lead";
/** Entity of the lead form (module «Заявки»). */
const LEAD_ENTITY = "lead";

export interface HomeInput {
  /** The compiled spec so far: roles, permissions and the pages of the modules (without «/»). */
  spec: AppSpec;
  /** The plan's niche (a line above the name when the name differs from it). */
  niche: string;
  present: ReadonlySet<string>;
  /** Resolved parameters of the plan modules by module id. */
  params: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The owner's cabinet route (the first login role's), if any. */
  cabinet: string | undefined;
}

/** What the public can do on the system: actions in priority order and the blocks of the home page. */
export interface HomeActions {
  /** Public actions (booking, lead form, catalog, other public pages, the visitor's pages), the primary first. */
  actions: Link[];
  /** The page shows the catalog showcase. */
  showcase: boolean;
  /** The page has the lead form (anchor #lead). */
  leadForm: boolean;
  booking: boolean;
}

const login = (next: string | undefined, role?: string): string =>
  next
    ? `/login?${new URLSearchParams({ ...(role ? { role } : {}), next }).toString()}`
    : role
      ? `/login?${new URLSearchParams({ role }).toString()}`
      : "/login";

/** Public actions of the compiled system; empty — a back-office-only system (the home is a staff sign-in page). */
export function homeActions(input: Pick<HomeInput, "spec" | "present" | "params">): HomeActions {
  const { spec, present, params } = input;
  const pages: Page[] = spec.pages ?? [];
  const publicRole = spec.roles.find((r) => r.access === "public")?.name;
  const isPublic = (p: Page) => !!publicRole && p.roles.includes(publicRole);
  const actions: Link[] = [];
  const booking = pages.some((p) => p.route === BOOKING_ROUTE && isPublic(p));
  if (booking) actions.push({ label: "Записаться", href: BOOKING_ROUTE });
  const leadForm =
    present.has("leads") &&
    !!publicRole &&
    (spec.permissions ?? []).some(
      (p) => p.role === publicRole && p.entity === LEAD_ENTITY && p.ops.includes("create"),
    );
  if (leadForm) actions.push({ label: "Оставить заявку", href: `#${HOME_LEAD_ANCHOR}` });
  const showcase = pages.some((p) => p.route === SHOWCASE.route && isPublic(p));
  if (showcase)
    actions.push({ label: catalogOptions(params.catalog ?? {}).showcaseTitle, href: SHOWCASE.route });
  const known = new Set(["/", BOOKING_ROUTE, SHOWCASE.route, PHOTO_CREDITS_ROUTE]);
  for (const p of pages)
    if (isPublic(p) && p.nav && !known.has(p.route) && !p.route.includes(":"))
      actions.push({ label: p.title, href: p.route });
  // Pages of the self sign-up role (the visitor cabinet first — the shortest route, /me before /materials): through
  // /login with the role, so a new visitor signs up.
  const byLength = [...pages].sort((a, b) => a.route.length - b.route.length);
  for (const r of spec.roles.filter((x) => x.access === "login" && x.selfSignup))
    for (const p of byLength)
      if (p.roles.includes(r.name) && !isPublic(p) && p.nav && !p.route.startsWith("/cabinet")) {
        const mine = p.route === "/me" && params.visitor_cabinet?.show_bookings === true && booking;
        actions.push({ label: mine ? "Мои записи" : p.title, href: login(p.route, r.name) });
      }
  return { actions, showcase, leadForm, booking };
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One line under the name: what a visitor does here. */
function description(h: HomeActions): string | undefined {
  if (h.booking) return "Запись онлайн: выберите услугу и удобное время.";
  if (h.leadForm) return "Оставьте заявку — мы свяжемся с вами.";
  if (h.showcase) return "Актуальные позиции и цены — на одной странице.";
  // Only the visitor's pages (an online school's students): sign in by a one-time code.
  return "Войдите по одноразовому коду, чтобы открыть личный кабинет.";
}

/** TSX of «/» without the landing: the public home, or the staff sign-in page of a back-office-only system. */
export function homePage(input: HomeInput): string {
  const { spec, niche, cabinet } = input;
  const brand = spec.app.name;
  const eyebrow = sameText(niche, brand) ? undefined : niche.charAt(0).toUpperCase() + niche.slice(1);
  const h = homeActions(input);
  const signIn = login(cabinet);
  const imports = ["Header", "Hero", "Footer"];
  const blocks: string[] = [];

  if (!h.actions.length) {
    // Back office: the team signs in; nothing here for the public.
    blocks.push(jsxEl("Header", [["brand", brand]]));
    blocks.push(
      jsxEl("Hero", [
        ["title", brand],
        ["subtitle", "Рабочее пространство команды. Войдите, чтобы открыть кабинет."],
        ["eyebrow", eyebrow],
        ["primary", { label: "Войти", href: signIn }],
        ["variant", "minimal", "lit"],
      ]),
    );
    blocks.push(
      jsxEl("Footer", [
        ["brand", brand],
        ["variant", "minimal", "lit"],
      ]),
    );
    return fragmentPage(
      "// Generated by the module engine (B2-45): «/» of a back-office system — the staff sign-in page.",
      imports,
      blocks,
    );
  }

  const [primary, secondary, ...rest] = h.actions;
  const links = [secondary, ...rest].filter((l): l is Link => !!l).slice(0, 4);
  blocks.push(
    jsxEl("Header", [
      ["brand", brand],
      ["links", links.length ? links : undefined],
      ["cta", primary],
      ["sticky", true],
    ]),
  );
  blocks.push(
    jsxEl("Hero", [
      ["title", brand],
      ["subtitle", description(h)],
      ["eyebrow", eyebrow],
      ["primary", primary],
      ["secondary", secondary],
      ["variant", "centered", "lit"],
      ["anchor", "top", "lit"],
    ]),
  );
  // Body blocks alternate the page and the band background, as the landing rhythm does.
  let body = 0;
  const tone = (): JsxAttr => ["tone", body++ % 2 === 1 ? "alt" : undefined, "lit"];
  if (h.booking) {
    imports.push("Steps");
    blocks.push(
      jsxEl("Steps", [
        ["title", "Как записаться"],
        [
          "steps",
          [
            { title: "Выберите услугу" },
            { title: "Выберите день и свободное время" },
            { title: "Оставьте имя и контакты" },
          ],
        ],
        ["variant", "numbered", "lit"],
        ["anchor", "steps", "lit"],
        tone(),
      ]),
    );
  }
  if (h.showcase) {
    imports.push(SHOWCASE.component);
    blocks.push(
      jsxEl(SHOWCASE.component, [
        ["title", catalogOptions(input.params.catalog ?? {}).showcaseTitle],
        ["anchor", "services", "lit"],
        ["layout", "cards", "lit"],
        tone(),
      ]),
    );
  }
  if (h.leadForm) {
    imports.push("LeadForm");
    blocks.push(
      jsxEl("LeadForm", [
        ["entity", LEAD_ENTITY],
        ["title", "Оставьте заявку"],
        ["submitLabel", "Отправить"],
        ["variant", "card", "lit"],
        ["anchor", HOME_LEAD_ANCHOR, "lit"],
        tone(),
      ]),
    );
  }
  blocks.push(
    jsxEl("Footer", [
      ["brand", brand],
      ["columns", [{ title: "Для команды", links: [{ label: "Войти в кабинет", href: signIn }] }]],
      ["variant", "simple", "lit"],
    ]),
  );
  return fragmentPage(
    "// Generated by the module engine (B2-45): «/» without the landing — the public actions of the plan's modules.",
    imports,
    blocks,
    { [SHOWCASE.component]: SHOWCASE.importFrom },
  );
}
