// Contacts: phone, e-mail, address and hours as a list with icons, messenger links, and a map panel — a stylised
// SVG street grid with a pin (no third-party map until the owner connects Yandex Maps, D57).
import type { ReactNode } from "react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon, type IconName } from "../kit/icons.js";
import { line, linkSlot } from "../kit/slots.js";
import { focusRing, Heading, type Link, Section, secondaryBtn } from "../kit/ui.js";

export type ContactsSplitProps = {
  eyebrow?: string;
  title: string;
  phone?: string;
  email?: string;
  address?: string;
  hours?: string;
  messengers?: Link[];
  route?: Link;
  wzId?: string;
};

function Row({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <li className="flex gap-4 border-b border-border py-5">
      <Icon name={icon} className="mt-0.5 size-5 shrink-0 text-primary" />
      <div>
        <p className="text-small text-muted-foreground">{label}</p>
        <div className="mt-1 text-lead font-semibold">{children}</div>
      </div>
    </li>
  );
}

const STREETS = "M0 70h400M0 170h400M0 250h400M90 0v300M210 0v300M330 0v300M0 0l400 300M40 300l220-300";

export default function ContactsSplit({
  eyebrow,
  title,
  phone,
  email,
  address,
  hours,
  messengers,
  route,
  wzId,
}: ContactsSplitProps) {
  return (
    <Section block="ContactsSplit" wzId={wzId}>
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <Heading eyebrow={eyebrow} title={title} />
          <ul className="mt-8 border-t border-border">
            {phone ? (
              <Row icon="phone" label="Телефон">
                <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className={focusRing}>
                  {phone}
                </a>
              </Row>
            ) : null}
            {email ? (
              <Row icon="mail" label="Почта">
                <a href={`mailto:${email}`} className={`break-all ${focusRing}`}>
                  {email}
                </a>
              </Row>
            ) : null}
            {address ? (
              <Row icon="map-pin" label="Адрес">
                {address}
              </Row>
            ) : null}
            {hours ? (
              <Row icon="clock" label="Часы работы">
                {hours}
              </Row>
            ) : null}
          </ul>
          {messengers?.length ? (
            <div className="mt-8 flex flex-wrap gap-3">
              {messengers.map((m) => (
                <a key={m.href} href={m.href} className={secondaryBtn}>
                  <Icon name="send" className="size-4" />
                  {m.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative min-h-80 overflow-hidden rounded-lg border border-border bg-muted lg:col-span-7">
          <svg
            aria-hidden="true"
            viewBox="0 0 400 300"
            preserveAspectRatio="xMidYMid slice"
            className="absolute inset-0 size-full text-border"
          >
            <path d={STREETS} stroke="currentColor" strokeWidth="10" fill="none" />
            <path d={STREETS} stroke="var(--color-background)" strokeWidth="6" fill="none" />
          </svg>
          <span className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-full place-items-center rounded-full bg-primary text-primary-foreground shadow-lg">
            <Icon name="map-pin" className="size-7" />
          </span>
          {route ? (
            <a
              href={route.href}
              className={`absolute right-4 bottom-4 left-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-background px-5 text-body font-semibold text-foreground shadow-md sm:left-auto ${focusRing}`}
            >
              {route.label}
              <Icon name="arrow-up-right" className="size-4" />
            </a>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof ContactsSplit>()({
  id: "contacts-split",
  kind: "contacts",
  title: "Контакты и схема проезда",
  description:
    "Телефон, почта, адрес и часы списком с иконками, кнопки мессенджеров; справа — стилизованная схема с меткой и ссылкой «Построить маршрут». Карта Яндекса подставляется компонентом платформы, когда подключена.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    phone: line(24).optional(),
    email: line(80).optional(),
    address: line(140).optional(),
    hours: line(80).optional(),
    messengers: z.array(linkSlot).max(3).optional(),
    route: linkSlot.optional(),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "none",
  origin: "own",
  example: {
    eyebrow: "Контакты",
    title: "Шоурум на Соколе — приходите посмотреть свет вживую",
    phone: "+7 495 120-45-67",
    email: "hello@lumen.example",
    address: "Москва, Ленинградский проспект, 74, корп. 2",
    hours: "Пн–Сб 10:00–20:00",
    messengers: [{ label: "Telegram", href: "https://t.me/example" }],
    route: { label: "Построить маршрут", href: "https://yandex.ru/maps" },
  },
});
