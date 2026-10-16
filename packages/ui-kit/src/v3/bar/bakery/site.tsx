// «Мастерская» bar site: a sourdough bakery on one page (grill-11 (2)). Each section is its own component with typed
// props, so the page can later be cut into blocks with slots; the signature moment is the oven rail (OvenRail).
import { domAnimation, LazyMotion, m } from "motion/react";
import { useEffect, useState } from "react";
import type { PhotoSlot } from "../photos.js";
import { type Photo, rub, useStill } from "../still.js";
import { BAKERY, type BakeItem, type MenuGroup, type PreorderItem } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
type Link = { label: string; href: string };

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const button = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-accent-strong ${focus}`;

const minutes = (hhmm: string) => {
  const [h, mm] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (mm ?? 0);
};
const clock = (hhmm: string) => hhmm.replace(/^0/, "");

/** Moscow wall time «HH:MM» (the bakery's own clock, whatever the visitor's zone). */
function moscowNow(): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function Img({ photo, className }: { photo: Photo; className?: string }) {
  return (
    <img
      src={photo.src}
      alt={photo.alt}
      decoding="async"
      className={`size-full object-cover ${className ?? ""}`}
    />
  );
}

/** Round stamp of the address, drawn like an ink mark on a flour sack. */
function Stamp({ lines }: { lines: readonly string[] }) {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" className="size-28 -rotate-12 text-accent-text lg:size-32">
      <circle cx="60" cy="60" r="56" fill="var(--ds-color-surface)" stroke="currentColor" strokeWidth="2.5" />
      <circle
        cx="60"
        cy="60"
        r="47"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <text
        x="60"
        y="54"
        textAnchor="middle"
        fill="currentColor"
        className="font-display"
        fontSize="15"
        fontWeight="700"
      >
        {lines[0]}
      </text>
      <text
        x="60"
        y="80"
        textAnchor="middle"
        fill="currentColor"
        className="font-display"
        fontSize="28"
        fontWeight="700"
      >
        {lines[1]}
      </text>
    </svg>
  );
}

export function BakeryHeader({
  name,
  nav,
  phone,
  phoneHref,
}: {
  name: string;
  nav: readonly Link[];
  phone: string;
  phoneHref: string;
}) {
  return (
    <header className="border-b border-line bg-background">
      <div className="mx-auto flex max-w-page items-center justify-between gap-6 px-gutter py-4">
        <a href="#top" className={`font-display text-xl font-bold text-foreground ${focus}`}>
          {name}
        </a>
        <nav aria-label="Разделы" className="hidden gap-7 text-body md:flex">
          {nav.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={`text-foreground underline-offset-4 hover:underline ${focus}`}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <a
          href={phoneHref}
          className={`text-small font-bold whitespace-nowrap text-accent-text tabular-nums ${focus}`}
        >
          {phone}
        </a>
      </div>
    </header>
  );
}

export function BakeryFirst(p: {
  title: string;
  lead: string;
  action: Link;
  more: Link;
  today: string;
  stamp: readonly string[];
  photo: Photo;
}) {
  return (
    <section id="top" className="bg-background text-foreground">
      <div className="mx-auto grid max-w-page gap-8 px-gutter pt-10 pb-section lg:grid-cols-12 lg:gap-x-10 lg:pt-14">
        <h1 className="font-display text-hero font-bold text-balance lg:col-span-10">{p.title}</h1>
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg lg:col-span-8 lg:aspect-[16/10]">
          <Img photo={p.photo} />
        </div>
        <div className="flex flex-col lg:col-span-4">
          <div className="hidden lg:block">
            <Stamp lines={p.stamp} />
          </div>
          <p className="max-w-text text-lead text-pretty text-muted-foreground lg:mt-8">{p.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
            <a href={p.action.href} className={button}>
              {p.action.label}
            </a>
            <a
              href={p.more.href}
              className={`text-body font-bold text-accent-text underline underline-offset-4 ${focus}`}
            >
              {p.more.label}
            </a>
          </div>
          <p className="mt-8 border-t border-line pt-4 text-small text-muted-foreground lg:mt-auto">
            {p.today}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Signature moment of the bakery: the day's oven rail from opening to closing. The marker runs from the start of the
 * day to the current Moscow time and each sort «comes out» as the marker passes it; still — the final frame.
 */
export function OvenRail(p: {
  title: string;
  note: string;
  closed: string;
  open: string;
  close: string;
  bakes: readonly BakeItem[];
  photo: Photo;
  now?: string;
}) {
  const still = useStill();
  const [now, setNow] = useState(p.now ?? "09:40");
  useEffect(() => {
    if (p.now) return;
    setNow(moscowNow());
    const t = setInterval(() => setNow(moscowNow()), 60_000);
    return () => clearInterval(t);
  }, [p.now]);
  const start = minutes(p.open);
  const span = minutes(p.close) - start;
  const at = (hhmm: string) => Math.min(1, Math.max(0, (minutes(hhmm) - start) / span));
  const nowAt = at(now);
  const closed = minutes(now) < minutes(p.bakes[0]?.time ?? p.open) || minutes(now) >= minutes(p.close);
  const out = (b: BakeItem) => !closed && minutes(b.time) <= minutes(now);
  const RUN = 1.8;
  return (
    <LazyMotion features={domAnimation}>
      <section id="oven" className="bg-muted py-section text-foreground">
        <div className="mx-auto grid max-w-page gap-10 px-gutter lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="font-display text-h1 font-bold text-balance">{p.title}</h2>
            <p className="mt-4 max-w-text text-body text-muted-foreground">{p.note}</p>
            <div className="mt-8 hidden aspect-[4/3] overflow-hidden rounded-md lg:block">
              <Img photo={p.photo} />
            </div>
          </div>
          <div className="lg:col-span-8">
            <p className="font-display text-h3 font-bold tabular-nums" aria-live="polite">
              {closed ? p.closed : `Сейчас ${clock(now)}`}
            </p>
            {/* The rail: wide screens only; the list below carries the same facts on every width. */}
            <div className="relative mt-10 mb-14 hidden h-16 lg:block" aria-hidden="true">
              <div className="absolute inset-x-0 top-8 h-0.5 bg-border" />
              {Array.from({ length: span / 60 + 1 }, (_, i) => i * 60).map((min) => (
                <span
                  key={min}
                  className="absolute top-6 h-4 w-px bg-border"
                  style={{ left: `${(min * 100) / span}%` }}
                />
              ))}
              {p.bakes.map((b) => (
                <div
                  key={b.time}
                  className="absolute top-0 -translate-x-1/2"
                  style={{ left: `${at(b.time) * 100}%` }}
                >
                  <m.span
                    className={`block size-4 translate-y-6 rounded-full border-2 ${out(b) ? "border-primary bg-primary" : "border-border bg-card"}`}
                    initial={
                      still || !out(b) ? false : { scale: 0.4, backgroundColor: "var(--ds-color-surface)" }
                    }
                    whileInView={
                      still || !out(b) ? undefined : { scale: 1, backgroundColor: "var(--ds-color-accent)" }
                    }
                    viewport={{ once: true }}
                    transition={{ delay: (at(b.time) / Math.max(nowAt, 0.01)) * RUN, duration: 0.3 }}
                  />
                  <span className="mt-9 block text-small text-muted-foreground tabular-nums">
                    {clock(b.time)}
                  </span>
                </div>
              ))}
              {closed ? null : (
                <m.div
                  className="absolute top-2 h-12 w-0.5 bg-accent-text"
                  initial={still ? false : { left: "0%" }}
                  whileInView={still ? undefined : { left: `${nowAt * 100}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: RUN, ease: [0.45, 0, 0.2, 1] }}
                  style={{ left: `${nowAt * 100}%` }}
                />
              )}
            </div>
            <ol className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {p.bakes.map((b) => (
                <li key={b.time} className="flex items-baseline gap-4 bg-card p-5">
                  <span className="font-display text-h3 font-bold tabular-nums">{clock(b.time)}</span>
                  <span>
                    <span className="block text-body font-bold">{b.name}</span>
                    <span
                      className={`block text-small ${out(b) ? "text-accent-text" : "text-muted-foreground"}`}
                    >
                      {out(b) ? `На витрине, ${b.note}` : `Будет в ${clock(b.time)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>
    </LazyMotion>
  );
}

export function BakeryMenu(p: {
  title: string;
  note: string;
  groups: readonly MenuGroup[];
  photos: readonly Photo[];
}) {
  return (
    <section id="menu" className="bg-background py-section text-foreground">
      <div className="mx-auto grid max-w-page gap-12 px-gutter lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h2 className="font-display text-h1 font-bold">{p.title}</h2>
          <p className="mt-3 text-body text-muted-foreground">{p.note}</p>
          {p.groups.map((g) => (
            <div key={g.title} className="mt-10">
              <h3 className="border-b-2 border-foreground pb-2 font-display text-h3 font-bold">{g.title}</h3>
              <ul>
                {g.items.map((it) => (
                  <li key={it.name} className="border-b border-line py-4">
                    <div className="flex items-baseline gap-3">
                      <span className="text-body font-bold">{it.name}</span>
                      {it.weight ? (
                        <span className="text-small text-muted-foreground">{it.weight}</span>
                      ) : null}
                      <span
                        aria-hidden="true"
                        className="min-w-6 flex-1 translate-y-[-0.3em] border-b border-dotted border-border"
                      />
                      <span className="text-body font-bold tabular-nums">{rub(it.price)}</span>
                    </div>
                    {it.note ? <p className="mt-1 text-small text-muted-foreground">{it.note}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 self-start lg:col-span-5 lg:mt-24 lg:grid-cols-1">
          {p.photos.map((ph) => (
            <figure key={ph.src} className="aspect-[4/5] overflow-hidden rounded-md lg:aspect-[3/2]">
              <Img photo={ph} />
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BakeryStory(p: { title: string; text: readonly string[]; photo: Photo }) {
  return (
    <section className="bg-inverse py-section text-inverse-foreground">
      <div className="mx-auto grid max-w-page items-center gap-10 px-gutter lg:grid-cols-12">
        <div className="aspect-[3/2] overflow-hidden rounded-md lg:col-span-6">
          <Img photo={p.photo} />
        </div>
        <div className="lg:col-span-5 lg:col-start-8">
          <h2 className="font-display text-h1 font-bold text-balance">{p.title}</h2>
          {p.text.map((t) => (
            <p key={t} className="mt-5 max-w-text text-lead text-pretty">
              {t}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BakeryPreorder(p: {
  title: string;
  rules: readonly string[];
  days: readonly string[];
  items: readonly PreorderItem[];
  submit: string;
  done: string;
  photo: Photo;
}) {
  const [qty, setQty] = useState<Record<string, number>>({ wheat: 1, rye: 0, grain: 0, cardamom: 4 });
  const [day, setDay] = useState(p.days[0] ?? "");
  const [sent, setSent] = useState(false);
  const total = p.items.reduce((s, it) => s + (qty[it.id] ?? 0) * it.price, 0);
  const step = (id: string, d: number) =>
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(20, (q[id] ?? 0) + d)) }));
  const field = `mt-1 block min-h-12 w-full rounded-control border border-border bg-card px-4 text-body text-foreground ${focus}`;
  return (
    <section id="preorder" className="bg-muted py-section text-foreground">
      <div className="mx-auto grid max-w-page gap-10 px-gutter lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h2 className="font-display text-h1 font-bold">{p.title}</h2>
          <ul className="mt-6 space-y-3 text-body">
            {p.rules.map((r) => (
              <li key={r} className="border-l-2 border-primary pl-4">
                {r}
              </li>
            ))}
          </ul>
          <div className="mt-8 hidden aspect-[4/5] overflow-hidden rounded-md lg:block">
            <Img photo={p.photo} />
          </div>
        </div>
        <form
          className="rounded-lg border border-line bg-card p-6 lg:col-span-8 lg:p-10"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <fieldset>
            <legend className="text-small font-bold">День</legend>
            <div className="mt-2 flex gap-2">
              {p.days.map((d) => (
                <label
                  key={d}
                  className={`inline-flex min-h-11 cursor-pointer items-center rounded-control border px-5 text-body has-focus-visible:outline-2 has-focus-visible:outline-ring ${day === d ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="day"
                    value={d}
                    checked={day === d}
                    onChange={() => setDay(d)}
                    className="sr-only"
                  />
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <ul className="mt-8 divide-y divide-line border-y border-line">
            {p.items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <span className="text-body">
                  <span className="font-bold">{it.name}</span>
                  <span className="ml-2 text-small text-muted-foreground tabular-nums">{rub(it.price)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Меньше: ${it.name}`}
                    onClick={() => step(it.id, -1)}
                    className={`size-11 rounded-control border border-border text-h3 ${focus}`}
                  >
                    −
                  </button>
                  <output
                    className="w-10 text-center text-body font-bold tabular-nums"
                    aria-label={`Количество: ${it.name}`}
                  >
                    {qty[it.id] ?? 0}
                  </output>
                  <button
                    type="button"
                    aria-label={`Больше: ${it.name}`}
                    onClick={() => step(it.id, 1)}
                    className={`size-11 rounded-control border border-border text-h3 ${focus}`}
                  >
                    +
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <label className="text-small font-bold">
              Имя
              <input name="name" autoComplete="given-name" required className={field} />
            </label>
            <label className="text-small font-bold">
              Телефон
              <input name="phone" type="tel" autoComplete="tel" required inputMode="tel" className={field} />
            </label>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
            <p className="text-h3 font-bold tabular-nums">
              Итого <span className="font-display">{rub(total)}</span>
            </p>
            <button type="submit" disabled={total === 0} className={`${button} disabled:opacity-60`}>
              {p.submit}
            </button>
          </div>
          {sent ? (
            <p role="status" className="mt-6 rounded-md bg-accent-soft p-4 text-body">
              {p.done}
            </p>
          ) : null}
        </form>
      </div>
    </section>
  );
}

export function BakeryVisit(p: {
  title: string;
  address: string;
  addressNote: string;
  hours: readonly (readonly [string, string])[];
  phone: string;
  phoneHref: string;
}) {
  return (
    <section id="visit" className="bg-background py-section text-foreground">
      <div className="mx-auto grid max-w-page gap-10 px-gutter lg:grid-cols-12">
        <div className="lg:col-span-6">
          <h2 className="font-display text-h1 font-bold">{p.title}</h2>
          <p className="mt-6 font-display text-h2 font-bold text-balance">{p.address}</p>
          <p className="mt-4 max-w-text text-body text-muted-foreground">{p.addressNote}</p>
          <a
            href={p.phoneHref}
            className={`mt-6 inline-block text-lead font-bold text-accent-text tabular-nums underline underline-offset-4 ${focus}`}
          >
            {p.phone}
          </a>
        </div>
        <table className="self-end text-body lg:col-span-5 lg:col-start-8">
          <caption className="sr-only">Часы работы</caption>
          <tbody>
            {p.hours.map(([d, h]) => (
              <tr key={d} className="border-b border-line">
                <th scope="row" className="py-4 pr-6 text-left font-normal text-muted-foreground">
                  {d}
                </th>
                <td className="py-4 text-right font-bold tabular-nums">{h}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BarFooter({ legal, credits }: { legal: string; credits: readonly Photo[] }) {
  return (
    <footer className="border-t border-line bg-background py-10 text-small text-muted-foreground">
      <div className="mx-auto max-w-page px-gutter">
        <p>{legal}</p>
        <p className="mt-2">Фото: {credits.map((c) => c.credit).join("; ")}.</p>
      </div>
    </footer>
  );
}

/** The whole bakery page; `now` pins the oven clock (snapshots), otherwise Moscow time. */
export default function BakerySite({ photos, now }: { photos: Photos; now?: string }) {
  const b = BAKERY;
  const used = [b.first.photo, b.oven.photo, ...b.menu.photos, b.story.photo, b.preorder.photo] as const;
  return (
    <div className="bg-background font-text text-foreground">
      <BakeryHeader name={b.name} nav={b.nav} phone={b.phone} phoneHref={b.phoneHref} />
      <main>
        <BakeryFirst {...b.first} photo={photos[b.first.photo]} />
        <OvenRail {...b.oven} photo={photos[b.oven.photo]} {...(now ? { now } : {})} />
        <BakeryMenu {...b.menu} photos={b.menu.photos.map((s) => photos[s])} />
        <BakeryStory {...b.story} photo={photos[b.story.photo]} />
        <BakeryPreorder {...b.preorder} photo={photos[b.preorder.photo]} />
        <BakeryVisit
          {...b.visit}
          address={b.address}
          addressNote={b.addressNote}
          phone={b.phone}
          phoneHref={b.phoneHref}
        />
      </main>
      <BarFooter legal={b.legal} credits={used.map((s) => photos[s])} />
    </div>
  );
}
