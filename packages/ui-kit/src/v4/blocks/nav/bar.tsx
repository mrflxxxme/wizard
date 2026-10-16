// Navigation bar: brand, up to six links and one action; on phones a disclosure menu (details/summary, no JS).
// Variant «floating» is a pill over the first screen with backdrop blur.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { line, linkSlot, variantSlot } from "../kit/slots.js";
import { focusRing, type Link, primaryBtn } from "../kit/ui.js";

const VARIANTS = ["solid", "floating"] as const;

export type NavBarProps = {
  brand: { name: string; href?: string };
  links: Link[];
  action?: Link;
  phone?: string;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function NavBar({ brand, links, action, phone, variant = "solid", wzId }: NavBarProps) {
  const floating = variant === "floating";
  return (
    <header
      data-wz-component="NavBar"
      data-wz-id={wzId}
      className={`sticky top-0 z-40 font-sans text-foreground ${floating ? "px-gutter pt-4" : "border-b border-border bg-background/85 backdrop-blur"}`}
    >
      <div
        className={`mx-auto flex w-full items-center gap-6 ${floating ? "max-w-[64rem] rounded-control border border-border bg-background/75 py-2 pr-2 pl-5 shadow-sm backdrop-blur" : "max-w-page px-gutter py-3"}`}
      >
        <a href={brand.href ?? "/"} className={`font-display text-h3 font-bold ${focusRing}`}>
          {brand.name}
        </a>
        <nav aria-label="Основное меню" className="ml-auto hidden lg:block">
          <ul className="flex items-center gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className={`rounded-control px-3 py-2 text-small font-medium text-muted-foreground transition-colors hover:text-foreground ${focusRing}`}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {phone ? (
          <a
            href={`tel:${phone.replace(/[^\d+]/g, "")}`}
            className={`hidden text-small font-semibold xl:block ${focusRing}`}
          >
            {phone}
          </a>
        ) : null}
        {action ? (
          <a href={action.href} className={`${primaryBtn} hidden lg:inline-flex`}>
            {action.label}
          </a>
        ) : null}
        <details className="group ml-auto lg:hidden">
          <summary
            className={`grid size-11 cursor-pointer list-none place-items-center rounded-control border border-border [&::-webkit-details-marker]:hidden ${focusRing}`}
            aria-label="Меню"
          >
            <Icon name="menu" className="size-5 group-open:hidden" />
            <Icon name="x" className="hidden size-5 group-open:block" />
          </summary>
          <div className="absolute inset-x-gutter top-full mt-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg">
            <ul className="grid">
              {links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={`block rounded-md px-3 py-3 text-body ${focusRing}`}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            {action ? (
              <a href={action.href} className={`${primaryBtn} mt-3 w-full`}>
                {action.label}
              </a>
            ) : null}
          </div>
        </details>
      </div>
    </header>
  );
}

export const block = defineBlock<typeof NavBar>()({
  id: "nav-bar",
  kind: "nav",
  title: "Шапка с меню",
  description:
    "Липкая шапка: название, до шести ссылок, телефон и одна кнопка; на телефоне — раскрывающееся меню без JS. «Плавающая» — капсула поверх первого экрана.",
  slots: z.object({
    brand: z.object({ name: line(40), href: linkSlot.shape.href.optional() }),
    links: z.array(linkSlot).min(2).max(6),
    action: linkSlot.optional(),
    phone: line(24).optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "solid", title: "Полоса во всю ширину" },
    { id: "floating", title: "Плавающая капсула" },
  ],
  effect: "none",
  origin: "own",
  example: {
    brand: { name: "Люмен" },
    links: [
      { label: "Услуги", href: "#services" },
      { label: "Работы", href: "#gallery" },
      { label: "Цены", href: "#pricing" },
      { label: "Вопросы", href: "#faq" },
      { label: "Контакты", href: "#contacts" },
    ],
    action: { label: "Заказать замер", href: "#form" },
    phone: "+7 495 120-45-67",
  },
});
