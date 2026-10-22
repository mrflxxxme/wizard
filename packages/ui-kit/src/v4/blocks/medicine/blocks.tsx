// Blocks of the direction «Чистая медицина» (V5-09, grill-12 (2)): a clinic with online booking. Grammar of a medical
// form: cool white, hairlines instead of cards, small letter-spaced labels, big tabular figures for time and price,
// photos in straight crops to the edge. The first screen is the booking itself; the signature is the treatment plan
// that sums up before the first drill.
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Credit, focus, Img, type Photo, rub, useStill } from "../kit.js";
import type { BlockProps } from "../types.js";

const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-semibold text-primary-foreground hover:bg-accent-strong ${focus}`;
const label = "text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground";
const num = "font-display font-semibold tabular-nums tracking-tight";
const h2 =
  "font-display font-semibold leading-[1] tracking-tight text-[calc(var(--ds-text-display)*0.8)] lg:text-[calc(var(--ds-text-display)*1.1)]";
const rule = "border-t border-foreground";

export type NavLink = { id: string; label: string };

/** Content of chistaya-medicina.header. */
export type MedHeaderContent = {
  name: string;
  logo?: ReactNode;
  nav: readonly NavLink[];
  phone: string;
  phoneHref: string;
  hours: string;
};

/** Header: mark, anchors, hours and phone on one hairline. */
export function MedHeader({ content: c }: BlockProps<MedHeaderContent>) {
  return (
    <header className="flex items-center justify-between gap-6 border-b border-line px-gutter py-4">
      {c.logo ?? <span className="font-display text-xl font-semibold">{c.name}</span>}
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-semibold lg:flex">
        {c.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`hover:text-accent-text ${focus}`}>
            {n.label}
          </a>
        ))}
      </nav>
      <div className="text-right">
        <a
          href={c.phoneHref}
          className={`block text-sm font-semibold whitespace-nowrap tabular-nums sm:text-base ${focus}`}
        >
          {c.phone}
        </a>
        <p className="hidden text-[0.75rem] text-muted-foreground sm:block">{c.hours}</p>
      </div>
    </header>
  );
}

/** A window of the schedule; an empty `doctor` marks it taken. */
export type Slot = { time: string; doctor: string };
export type SlotDay = { id: string; label: string; slots: readonly Slot[] };

/** Content of chistaya-medicina.hero. */
export type MedHeroContent = {
  /** Anchor of the booking form (the other blocks link to it). */
  anchor: string;
  header: MedHeaderContent;
  photo: Photo;
  /** Caption on the photo: which room, which equipment. */
  photoNote: string;
  place: string;
  /** The offer with its price, 3–8 words. */
  title: string;
  days: readonly SlotDay[];
  phoneLabel: string;
  /** Button text; `{time}` is replaced by the chosen slot. */
  cta: string;
  note: string;
  facts: readonly { value: string; label: string }[];
  /** Condition of the price, small print. */
  footnote: string;
};

/** First screen as the booking: the offer with a price, today's free windows, a phone field, numbers of trust. */
export function MedHero({ content: c }: BlockProps<MedHeroContent>) {
  const [dayId, setDay] = useState(c.days[0]?.id ?? "");
  const day = c.days.find((d) => d.id === dayId) ?? (c.days[0] as SlotDay);
  const firstFree = (d: SlotDay) => d.slots.find((s) => s.doctor)?.time ?? "";
  const [time, setTime] = useState(firstFree(day));
  const slot = day.slots.find((s) => s.time === time);
  return (
    <section className="bg-background">
      <MedHeader content={c.header} />
      <div className="grid lg:grid-cols-12">
        <div className="px-gutter pt-8 pb-12 lg:col-span-7 lg:pt-14 lg:pb-16">
          <p className={label}>{c.place}</p>
          <h1 className="mt-4 max-w-[14ch] font-display text-[calc(var(--ds-text-display)*1.05)] font-semibold leading-[0.98] tracking-tight lg:text-[calc(var(--ds-text-display)*1.75)]">
            {c.title}
            <sup className="align-super text-[0.35em] text-muted-foreground">1</sup>
          </h1>
          <form
            id={c.anchor}
            aria-label="Запись на приём"
            onSubmit={(e) => e.preventDefault()}
            className="mt-8 max-w-2xl border-t-2 border-foreground pt-5"
          >
            <fieldset className="m-0 flex flex-wrap gap-x-6 gap-y-2 border-0 p-0">
              <legend className={`${label} mb-3`}>Свободные окна</legend>
              {c.days.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={d.id === day.id}
                  onClick={() => {
                    setDay(d.id);
                    setTime(firstFree(d));
                  }}
                  className={`min-h-11 border-b-2 text-base font-semibold ${d.id === day.id ? "border-accent text-accent-text" : "border-transparent text-muted-foreground"} ${focus}`}
                >
                  {d.label}
                </button>
              ))}
            </fieldset>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {day.slots.map((s) => (
                <button
                  key={s.time}
                  type="button"
                  disabled={!s.doctor}
                  aria-pressed={s.time === time}
                  onClick={() => setTime(s.time)}
                  className={`min-h-12 rounded-control border text-lg ${num} ${!s.doctor ? "border-line text-muted-foreground line-through" : s.time === time ? "border-accent bg-accent text-accent-ink" : "border-border hover:border-accent"} ${focus}`}
                >
                  {s.time}
                </button>
              ))}
            </div>
            <p className="mt-3 min-h-6 text-sm text-muted-foreground">{slot ? slot.doctor : ""}</p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <label className="flex-1">
                <span className="sr-only">{c.phoneLabel}</span>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder={c.phoneLabel}
                  className={`min-h-14 w-full rounded-control border border-border bg-card px-4 text-lg ${focus}`}
                />
              </label>
              <button type="submit" className={`${cta} min-h-14 text-lg`}>
                {c.cta.replace("{time}", time)}
              </button>
            </div>
            <p className="mt-3 text-sm">{c.note}</p>
          </form>
          <dl className="mt-10 grid max-w-2xl grid-cols-3 gap-4">
            {c.facts.map((f) => (
              <div key={f.label} className={`${rule} pt-2`}>
                <dt className="sr-only">{f.label}</dt>
                <dd className={`m-0 text-3xl lg:text-[calc(var(--ds-text-display)*0.75)] ${num}`}>
                  {f.value}
                </dd>
                <dd className="m-0 mt-1 text-sm text-muted-foreground">{f.label}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 max-w-2xl text-[0.75rem] text-muted-foreground">
            <sup>1</sup> {c.footnote}
          </p>
        </div>
        <figure className="relative m-0 min-h-80 lg:col-span-5 lg:min-h-full">
          <Img photo={c.photo} className="absolute inset-0" />
          <figcaption className="absolute bottom-0 left-0 m-4 max-w-xs bg-card px-3 py-2 text-sm text-foreground lg:m-6">
            {c.photoNote}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export type PriceRow = { name: string; what: string; price: number };

/** Content of chistaya-medicina.prices. */
export type MedPricesContent = {
  anchor: string;
  title: string;
  lead: string;
  groups: readonly { title: string; rows: readonly PriceRow[] }[];
  cta: string;
  ctaHref: string;
};

/** Price list: groups as row heads, each line with what is included and one fixed price. */
export function MedPrices({ content: c }: BlockProps<MedPricesContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-4">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-5 max-w-text text-lg">{c.lead}</p>
        <a href={c.ctaHref} className={`${cta} mt-8`}>
          {c.cta}
        </a>
      </div>
      <div className="lg:col-span-8">
        {c.groups.map((g) => (
          <div key={g.title} className="grid gap-x-8 border-t-2 border-foreground py-4 md:grid-cols-4">
            <h3 className={`${label} pt-2`}>{g.title}</h3>
            <ul className="m-0 list-none p-0 md:col-span-3">
              {g.rows.map((r) => (
                <li
                  key={r.name}
                  className="grid grid-cols-[1fr_auto] gap-x-6 border-b border-line py-3 last:border-0"
                >
                  <span className="text-base font-semibold">{r.name}</span>
                  <span className={`row-span-2 text-xl ${num}`}>{rub(r.price)}</span>
                  <span className="text-sm text-muted-foreground">{r.what}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export type PlanLine = { tooth: string; item: string; price: number };

/** Content of chistaya-medicina.plan (the signature). */
export type MedPlanContent = {
  anchor: string;
  title: string;
  lead: string;
  /** Points under the lead: what the plan guarantees. */
  points: readonly string[];
  sheet: { head: string; patient: string; lines: readonly PlanLine[]; totalLabel: string; stamp: string };
};

/** «План до первого сверла»: the plan sheet fills line by line, the total counts up, the stamp fixes the price. */
export function MedPlan({ content: c }: BlockProps<MedPlanContent>) {
  const still = useStill();
  const total = c.sheet.lines.reduce((s, l) => s + l.price, 0);
  const step = 0.45;
  const line = (i: number) =>
    still
      ? {}
      : {
          initial: { opacity: 0, x: -12 },
          whileInView: { opacity: 1, x: 0 },
          viewport: { once: true, amount: 0.4 },
          transition: { delay: 0.3 + i * step, duration: 0.35 },
        };
  const after = 0.3 + c.sheet.lines.length * step;
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 bg-surface-alt px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-5">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-5 max-w-text text-lg">{c.lead}</p>
        <ol className="mt-8 list-none space-y-0 p-0">
          {c.points.map((p, i) => (
            <li key={p} className="grid grid-cols-[2.5rem_1fr] border-t border-foreground py-3 text-base">
              <span className={`${num} text-accent-text`}>{String(i + 1).padStart(2, "0")}</span>
              {p}
            </li>
          ))}
        </ol>
      </div>
      <div className="relative lg:col-span-7">
        <div className="bg-card p-6 shadow-md lg:p-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-foreground pb-3">
            <p className={label}>{c.sheet.head}</p>
            <p className="text-sm text-muted-foreground">{c.sheet.patient}</p>
          </div>
          <ul className="m-0 list-none p-0">
            {c.sheet.lines.map((l, i) => (
              <motion.li
                key={`${l.tooth}-${l.item}-${still}`}
                {...line(i)}
                className="grid grid-cols-[3.5rem_1fr_auto] gap-x-4 border-b border-line py-3 text-base"
              >
                <span className={`${num} text-muted-foreground`}>{l.tooth}</span>
                <span>{l.item}</span>
                <span className={num}>{rub(l.price)}</span>
              </motion.li>
            ))}
          </ul>
          <div className="mt-4 flex items-end justify-between gap-4">
            <p className="text-base font-semibold">{c.sheet.totalLabel}</p>
            <motion.p
              key={`total-${still}`}
              className={`text-[calc(var(--ds-text-display)*0.9)] leading-none lg:text-[calc(var(--ds-text-display)*1.2)] ${num}`}
              {...(still
                ? {}
                : {
                    initial: { opacity: 0, y: 16 },
                    whileInView: { opacity: 1, y: 0 },
                    viewport: { once: true, amount: 0.4 },
                    transition: { delay: after, duration: 0.5 },
                  })}
            >
              {rub(total)}
            </motion.p>
          </div>
        </div>
        <motion.p
          key={`stamp-${still}`}
          aria-hidden="true"
          className="absolute -top-4 right-4 m-0 -rotate-6 border-2 border-accent bg-card px-3 py-1 text-sm font-bold uppercase tracking-[0.12em] text-accent-text lg:right-10"
          {...(still
            ? {}
            : {
                initial: { opacity: 0, scale: 1.6 },
                whileInView: { opacity: 1, scale: 1 },
                viewport: { once: true, amount: 0.4 },
                transition: { delay: after + 0.5, duration: 0.25, ease: "easeIn" },
              })}
        >
          {c.sheet.stamp}
        </motion.p>
        <p className="sr-only">{c.sheet.stamp}</p>
      </div>
    </section>
  );
}

export type Doctor = {
  name: string;
  role: string;
  years: string;
  fact: string;
  next: string;
  photo: Photo;
};

/** Content of chistaya-medicina.doctors. */
export type MedDoctorsContent = {
  anchor: string;
  title: string;
  lead: string;
  doctors: readonly Doctor[];
  cta: string;
  ctaHref: string;
};

/** Doctors: portrait crops in a row, name, experience in a figure, the next free window and a link to book. */
export function MedDoctors({ content: c }: BlockProps<MedDoctorsContent>) {
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="px-gutter py-16 lg:py-24">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="max-w-text text-lg">{c.lead}</p>
      </div>
      <ul className="mt-10 grid list-none gap-x-6 gap-y-12 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {c.doctors.map((d) => (
          <li key={d.name}>
            <div className="aspect-[4/5] overflow-hidden rounded-sm">
              <Img photo={d.photo} />
            </div>
            <p className={`${label} mt-4`}>{d.role}</p>
            <h3 className="mt-1 font-display text-2xl font-semibold leading-tight">{d.name}</h3>
            <p className="mt-2 text-base">
              <span className={num}>{d.years}</span> · {d.fact}
            </p>
            <a
              href={c.ctaHref}
              className={`mt-4 flex min-h-12 items-center justify-between border-t border-foreground pt-2 text-base font-semibold hover:text-accent-text ${focus}`}
            >
              <span>{d.next}</span>
              <span className="text-accent-text">{c.cta}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Content of chistaya-medicina.reviews. */
export type MedReviewsContent = {
  anchor: string;
  title: string;
  ratings: readonly { value: string; source: string }[];
  items: readonly { name: string; date: string; doctor: string; text: string }[];
};

/** Reviews: ratings of the outside services as big figures, then dated reviews naming the doctor and treatment. */
export function MedReviews({ content: c }: BlockProps<MedReviewsContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 border-t border-line px-gutter py-16 lg:grid-cols-12 lg:py-24"
    >
      <div className="lg:col-span-4">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <dl className="mt-8">
          {c.ratings.map((r) => (
            <div key={r.source} className={`${rule} py-3`}>
              <dt className="sr-only">{r.source}</dt>
              <dd className={`m-0 text-[calc(var(--ds-text-display)*1.1)] leading-none ${num}`}>{r.value}</dd>
              <dd className="m-0 mt-1 text-sm text-muted-foreground">{r.source}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ul className="m-0 list-none p-0 lg:col-span-8">
        {c.items.map((r) => (
          <li
            key={r.name}
            className="grid gap-2 border-t border-line py-6 first:border-foreground md:grid-cols-4"
          >
            <div>
              <p className="text-base font-semibold">{r.name}</p>
              <p className="text-sm text-muted-foreground">{r.date}</p>
            </div>
            <blockquote className="m-0 md:col-span-3">
              <p className="text-lg">{r.text}</p>
              <p className="mt-2 text-sm text-muted-foreground">{r.doctor}</p>
            </blockquote>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Content of chistaya-medicina.contacts. */
export type MedContactsContent = {
  anchor: string;
  title: string;
  address: string;
  way: readonly string[];
  hours: readonly { days: string; time: string }[];
  phone: string;
  phoneHref: string;
  cta: string;
  ctaHref: string;
  photo: Photo;
};

/** Address and the way in, hours as a table, the room photo to the edge. */
export function MedContacts({ content: c }: BlockProps<MedContactsContent>) {
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="grid bg-surface-alt lg:grid-cols-2">
      <div className="px-gutter py-16 lg:py-24">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-6 font-display text-2xl font-semibold">{c.address}</p>
        <ul className="mt-4 list-none space-y-1 p-0 text-base">
          {c.way.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <table className="mt-8 w-full max-w-md border-collapse text-base">
          <tbody>
            {c.hours.map((h) => (
              <tr key={h.days} className="border-t border-foreground">
                <th scope="row" className="py-2 text-left font-normal">
                  {h.days}
                </th>
                <td className={`py-2 text-right ${num}`}>{h.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <a href={c.ctaHref} className={cta}>
            {c.cta}
          </a>
          <a href={c.phoneHref} className={`min-h-12 content-center text-lg font-semibold ${num} ${focus}`}>
            {c.phone}
          </a>
        </div>
      </div>
      <div className="min-h-80">
        <Img photo={c.photo} />
      </div>
    </section>
  );
}

/** Content of chistaya-medicina.footer. */
export type MedFooterContent = {
  name: string;
  logo?: ReactNode;
  legal: readonly string[];
  /** The warning medical advertising must carry (38-ФЗ, ст. 24). */
  warning: string;
  credits: readonly string[];
};

/** Footer: legal entity and licence, the mandatory warning, photo credits. */
export function MedFooter({ content: c }: BlockProps<MedFooterContent>) {
  return (
    <footer className="px-gutter py-10">
      <p className="border-y-2 border-foreground py-4 text-center text-sm font-semibold uppercase tracking-[0.14em] lg:text-base">
        {c.warning}
      </p>
      <div className="mt-8 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4">
          {c.logo ?? <span className="font-display text-xl font-semibold">{c.name}</span>}
        </div>
        <ul className="m-0 list-none space-y-1 p-0 text-sm text-muted-foreground lg:col-span-8">
          {c.legal.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
      <Credit list={c.credits} className="mt-6 text-muted-foreground" />
    </footer>
  );
}
