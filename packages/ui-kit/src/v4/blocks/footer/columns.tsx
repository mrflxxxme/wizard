// Footer: brand with one line and contacts, 2–3 columns of links, legal line with the operator's requisites
// (152-ФЗ policy link). On the inverse colour so the page ends firmly.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { line, linkSlot, variantSlot } from "../kit/slots.js";
import { focusRing, type Link, Section } from "../kit/ui.js";

const VARIANTS = ["inverse", "plain"] as const;

export type FooterColumnsProps = {
  brand: { name: string; tagline?: string };
  columns: { title: string; links: Link[] }[];
  contacts?: string[];
  legal: string;
  policy?: Link;
  /** Huge brand wordmark across the bottom. */
  wordmark?: boolean;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function FooterColumns({
  brand,
  columns,
  contacts,
  legal,
  policy,
  wordmark,
  variant = "inverse",
  wzId,
}: FooterColumnsProps) {
  const inv = variant === "inverse";
  const soft = inv ? "opacity-80" : "text-muted-foreground";
  return (
    <Section
      block="FooterColumns"
      wzId={wzId}
      className={
        inv ? "bg-inverse text-inverse-foreground" : "border-t border-border bg-background text-foreground"
      }
      inner="pt-16 pb-8"
    >
      <div className="grid gap-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <p className="font-display text-h2 font-bold">{brand.name}</p>
          {brand.tagline ? <p className={`mt-3 max-w-xs text-body ${soft}`}>{brand.tagline}</p> : null}
          {contacts?.length ? (
            <ul className="mt-6 grid gap-1 text-body font-semibold">
              {contacts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <nav
          aria-label="Разделы сайта"
          className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:col-span-7 lg:col-start-6"
        >
          {columns.map((col) => (
            <div key={col.title}>
              <p className={`text-small font-semibold tracking-wide uppercase ${soft}`}>{col.title}</p>
              <ul className="mt-4 grid gap-2">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <a href={l.href} className={`text-body hover:underline ${focusRing}`}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      {wordmark ? (
        <p
          aria-hidden="true"
          className="mt-16 font-display text-[clamp(4rem,18vw,16rem)] leading-[0.8] font-bold tracking-tight opacity-10 select-none"
        >
          {brand.name}
        </p>
      ) : null}
      <div
        className={`mt-12 flex flex-col gap-3 border-t pt-6 text-small sm:flex-row sm:justify-between ${inv ? "border-inverse-foreground/20" : "border-border"} ${soft}`}
      >
        <p>{legal}</p>
        {policy ? (
          <a href={policy.href} className={`underline-offset-4 hover:underline ${focusRing}`}>
            {policy.label}
          </a>
        ) : null}
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof FooterColumns>()({
  id: "footer-columns",
  kind: "footer",
  title: "Подвал с колонками",
  description:
    "Название с короткой строкой и контактами, 2–3 колонки ссылок, реквизиты и ссылка на политику ПДн; по желанию — огромное название по низу. Тёмный по умолчанию, чтобы страница заканчивалась твёрдо.",
  slots: z.object({
    brand: z.object({ name: line(40), tagline: line(120).optional() }),
    columns: z
      .array(z.object({ title: line(24), links: z.array(linkSlot).min(1).max(6) }))
      .min(1)
      .max(3),
    contacts: z.array(line(60)).max(3).optional(),
    legal: line(200),
    policy: linkSlot.optional(),
    wordmark: z.boolean().optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "inverse", title: "Тёмный" },
    { id: "plain", title: "На фоне страницы" },
  ],
  effect: "none",
  origin: "own",
  example: {
    brand: { name: "Люмен", tagline: "Проектируем и монтируем свет в квартирах и домах с 2014 года." },
    columns: [
      {
        title: "Услуги",
        links: [
          { label: "Проект света", href: "/services/project" },
          { label: "Умный свет", href: "/services/smart" },
          { label: "Монтаж", href: "/services/install" },
        ],
      },
      {
        title: "Студия",
        links: [
          { label: "О нас", href: "/about" },
          { label: "Работы", href: "/works" },
          { label: "Отзывы", href: "/reviews" },
        ],
      },
      {
        title: "Связь",
        links: [
          { label: "Telegram", href: "https://t.me/example" },
          { label: "Контакты", href: "#contacts" },
        ],
      },
    ],
    contacts: ["+7 495 120-45-67", "hello@lumen.example"],
    legal: "© 2026 ООО «Люмен», ИНН 7700000000",
    policy: { label: "Политика обработки персональных данных", href: "/privacy" },
    wordmark: true,
  },
});
