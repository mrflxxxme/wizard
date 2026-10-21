// Blocks of the direction «Ночной продукт» (grill-11 (1)), cut from the accepted car service site С5 «Опишите
// проблему» (round 4). Each block renders one section from its content; the section markup is the accepted site's.
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Credit, focus, Img, type Photo, rub, useStill } from "./kit.js";
import type { BlockProps } from "./types.js";

const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-accent-strong ${focus}`;
const chip = (on: boolean) =>
  `min-h-11 rounded-control border px-3 text-sm font-bold ${on ? "border-accent bg-accent text-accent-ink" : "border-border text-foreground"} ${focus}`;
const big = "font-display font-bold leading-[0.95] tracking-tight";
const h2 =
  "font-display font-bold leading-[0.95] tracking-tight text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]";
const field = `mt-2 min-h-12 w-full rounded-control border border-border bg-background px-3 text-base ${focus}`;
const scrimSide = "absolute inset-0 bg-linear-to-r from-scrim via-scrim/85";

export type NavLink = { id: string; label: string };
export type CarModel = { id: string; label: string; prices: readonly number[] };

/** Content of nochnoy-produkt.header. */
export type NHeaderContent = {
  name: string;
  logo?: ReactNode;
  nav: readonly NavLink[];
  phone: string;
  phoneHref: string;
};

const Logo = ({ c }: { c: { name: string; logo?: ReactNode } }) =>
  c.logo ?? <span className="font-display text-lg font-bold leading-none">{c.name}</span>;

/** Header: mark, anchors to the sections (desktop), phone. */
export function NHeader({ content: c }: BlockProps<NHeaderContent>) {
  return (
    <header className="flex items-center justify-between gap-6 px-gutter py-5">
      <Logo c={c} />
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-bold lg:flex">
        {c.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`hover:text-accent-text ${focus}`}>
            {n.label}
          </a>
        ))}
      </nav>
      <a href={c.phoneHref} className={`min-h-12 content-center text-sm font-bold ${focus}`}>
        {c.phone}
      </a>
    </header>
  );
}

/** Content of nochnoy-produkt.hero. */
export type NHeroContent = {
  header: NHeaderContent;
  photo: Photo;
  title: string;
  fieldLabel: string;
  placeholder: string;
  cta: string;
  lead: string;
  /** Three numbers of trust: value and its label. */
  facts: readonly { value: string; label: string }[];
};

/** «Опишите проблему»: the first screen is a tool, one field and a quote button, numbers of trust under it. */
export function NHero({ content: c }: BlockProps<NHeroContent>) {
  return (
    <section className="relative isolate overflow-hidden text-scrim-foreground">
      <div className="absolute inset-0 -z-10">
        <Img photo={c.photo} />
        <div className={`${scrimSide} to-scrim/50`} />
      </div>
      <NHeader content={c.header} />
      <div className="px-gutter pt-8 pb-12 lg:pt-16 lg:pb-16">
        <h1
          className={`${big} text-[calc(var(--ds-text-display)*1.1)] lg:text-[calc(var(--ds-text-display)*2)]`}
        >
          {c.title}
        </h1>
        <form
          aria-label="Расчёт ремонта"
          onSubmit={(e) => e.preventDefault()}
          className="mt-8 flex max-w-5xl flex-col gap-3 lg:flex-row"
        >
          <label htmlFor="problem" className="sr-only">
            {c.fieldLabel}
          </label>
          <input
            id="problem"
            type="text"
            placeholder={c.placeholder}
            className={`min-h-16 flex-1 rounded-control border-2 border-border bg-background px-5 text-xl text-foreground ${focus}`}
          />
          <button type="submit" className={`${cta} min-h-16 text-lg`}>
            {c.cta}
          </button>
        </form>
        <p className="mt-3 text-base">{c.lead}</p>
        <dl className="mt-10 grid grid-cols-3 gap-6 lg:max-w-3xl">
          {c.facts.map((n) => (
            <div key={n.label} className="border-t-2 border-current pt-2">
              <dt className="sr-only">{n.label}</dt>
              <dd className="m-0 font-display text-3xl font-bold tabular-nums lg:text-5xl">{n.value}</dd>
              <dd className="m-0 text-sm">{n.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Content of nochnoy-produkt.prices. */
export type NPricesContent = {
  anchor: string;
  title: string;
  lead: string;
  models: readonly CarModel[];
  /** Jobs in the order of each model's `prices`. */
  jobs: readonly string[];
  cta: string;
  ctaHref: string;
};

/** «Цены для вашей машины»: pick the model, see jobs with prices «от» for it. */
export function NPrices({ content: c }: BlockProps<NPricesContent>) {
  const first = c.models[0] as CarModel;
  const [model, setModel] = useState<string>(first.id);
  const car = c.models.find((m) => m.id === model) ?? first;
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-5">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{c.lead}</p>
        <label className="mt-8 block text-sm font-bold">
          Машина
          <select value={model} onChange={(e) => setModel(e.target.value)} className={field}>
            {c.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="lg:col-span-6 lg:col-start-7">
        <h3 className="text-sm font-bold">Цены для {car.label}</h3>
        <ul className="mt-2 border-t-2 border-current">
          {c.jobs.map((j, i) => (
            <li key={j} className="flex items-baseline justify-between gap-4 border-b border-line py-3">
              <span className="text-lg">{j}</span>
              <span className="font-display text-2xl font-bold tabular-nums">
                от {rub(car.prices[i] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
        <a href={c.ctaHref} className={`${cta} mt-8`}>
          {c.cta}
        </a>
      </div>
    </section>
  );
}

/** Content of nochnoy-produkt.booking. */
export type NBookingContent = {
  anchor: string;
  title: string;
  days: readonly string[];
  slots: readonly string[];
  /** Slots taken on the first day: shown struck out. */
  busy: readonly string[];
  place: string;
  cta: string;
  note: string;
};

/** «Запись на время»: day chips, large time tiles with taken ones struck out, the chosen time and one submit. */
export function NBooking({ content: c }: BlockProps<NBookingContent>) {
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(0);
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="bg-surface-alt px-gutter py-14 lg:py-20"
    >
      <h2 id={`${c.anchor}-h`} className={h2}>
        {c.title}
      </h2>
      <form
        aria-label="Запись"
        onSubmit={(e) => e.preventDefault()}
        className="mt-8 grid gap-6 lg:grid-cols-12"
      >
        <fieldset className="border-0 p-0 lg:col-span-7">
          <legend className="text-sm font-bold">День и время</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {c.days.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={day === i}
                onClick={() => setDay(i)}
                className={chip(day === i)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {c.slots.map((s, i) => {
              const busy = day === 0 && c.busy.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  aria-pressed={slot === i}
                  onClick={() => setSlot(i)}
                  className={`${chip(slot === i)} min-h-16 font-display text-2xl tabular-nums disabled:line-through disabled:opacity-60`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-col gap-4 lg:col-span-4 lg:col-start-9">
          <p className="border-t-2 border-current pt-3 font-display text-3xl font-bold">
            {c.days[day]}, {c.slots[slot]}
          </p>
          <p className="text-sm">{c.place}</p>
          <button type="submit" className={cta}>
            {c.cta} на {c.slots[slot]}
          </button>
          <p className="text-sm text-muted-foreground">{c.note}</p>
        </div>
      </form>
    </section>
  );
}

/** Content of nochnoy-produkt.status. */
export type NStatusContent = {
  anchor: string;
  title: string;
  lead: string;
  car: string;
  stages: readonly string[];
  /** Index of the current stage. */
  current: number;
  master: string;
  chat: readonly { who: "master" | "client"; time: string; text: string; photo?: Photo }[];
};

/**
 * Signature moment of «Ночной продукт»: repair status as the master's chat. On a wide screen with motion allowed the
 * stages fill up to the current one and the messages arrive one by one; on 390 px and with reduced motion the final
 * frame stands.
 */
export function NStatus({ content: c }: BlockProps<NStatusContent>) {
  const still = useStill();
  const arrive = (i: number) =>
    still
      ? {}
      : {
          initial: { opacity: 0, y: 16 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, amount: 0.5 },
          transition: { duration: 0.45, delay: 0.3 + i * 0.7, ease: [0.22, 1, 0.36, 1] as const },
        };
  const fill = (i: number) =>
    still
      ? {}
      : {
          initial: { opacity: 0.35 },
          whileInView: { opacity: 1 },
          viewport: { once: true, amount: 0.5 },
          transition: { duration: 0.3, delay: i * 0.35 },
        };
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-5">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{c.lead}</p>
        <p className="mt-8 text-sm font-bold">{c.car}</p>
        <ol className="mt-3 grid grid-cols-4 gap-2">
          {c.stages.map((st, i) => (
            <motion.li
              key={`${st}-${still}`}
              aria-current={i === c.current ? "step" : undefined}
              className={`border-t-4 pt-2 text-sm ${i <= c.current ? "border-accent font-bold" : "border-line text-muted-foreground"}`}
              {...(i <= c.current ? fill(i) : {})}
            >
              {st}
            </motion.li>
          ))}
        </ol>
      </div>
      <ul aria-label="Чат с мастером" className="flex flex-col gap-4 lg:col-span-6 lg:col-start-7">
        {c.chat.map((m, i) => (
          <motion.li
            key={`${m.time}-${still}`}
            className={`max-w-[85%] border-l-4 pl-4 ${m.who === "client" ? "self-end border-accent" : "border-line"}`}
            {...arrive(i)}
          >
            <p className="text-sm text-muted-foreground">
              {m.who === "client" ? "Вы" : c.master}, {m.time}
            </p>
            {m.photo ? (
              <figure className="m-0 mt-2 aspect-[4/3] overflow-hidden">
                <Img photo={m.photo} />
              </figure>
            ) : null}
            <p className="mt-1 text-lg">{m.text}</p>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

/** Content of nochnoy-produkt.steps. */
export type NStepsContent = { title: string; items: readonly { n: string; title: string; text: string }[] };

/** «Как это работает»: four numbered steps on an accent rule. */
export function NSteps({ content: c }: BlockProps<NStepsContent>) {
  return (
    <section aria-labelledby="how" className="border-t-2 border-current px-gutter py-14 lg:py-20">
      <h2 id="how" className={h2}>
        {c.title}
      </h2>
      <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {c.items.map((st) => (
          <li key={st.n} className="border-t-4 border-accent pt-3">
            <span className="font-display text-5xl font-bold text-accent-text">{st.n}</span>
            <p className="mt-2 text-lg font-bold">{st.title}</p>
            <p className="text-base text-muted-foreground">{st.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Content of nochnoy-produkt.reviews. */
export type NReviewsContent = {
  title: string;
  rating: { value: string; source: string };
  /** Tail after the rating: «9 400 ремонтов». */
  tally: string;
  items: readonly { name: string; text: string }[];
};

/** Reviews: rating in the accent, three quotes with the car of each author. */
export function NReviews({ content: c }: BlockProps<NReviewsContent>) {
  return (
    <section aria-labelledby="reviews-h" className="bg-surface-alt px-gutter py-14 lg:py-20">
      <div className="flex flex-wrap items-baseline justify-between gap-6">
        <h2 id="reviews-h" className={h2}>
          {c.title}
        </h2>
        <p className="text-base">
          <span className="font-display text-3xl font-bold text-accent-text">{c.rating.value}</span> в{" "}
          {c.rating.source}, {c.tally}
        </p>
      </div>
      <ul className="mt-10 grid gap-10 lg:grid-cols-3">
        {c.items.map((r) => (
          <li key={r.name} className="border-t-2 border-current pt-4">
            <blockquote className="m-0 text-xl font-bold leading-snug">«{r.text}»</blockquote>
            <p className="mt-3 text-sm">{r.name}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Content of nochnoy-produkt.contacts. */
export type NContactsContent = {
  anchor: string;
  address: string;
  hours: string;
  photo: Photo;
  cta: string;
  ctaHref: string;
  phone: string;
  phoneHref: string;
};

/** Address as the heading over a dark photo of the bay, hours, booking and the phone. */
export function NContacts({ content: c }: BlockProps<NContactsContent>) {
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="relative isolate overflow-hidden text-scrim-foreground"
    >
      <div className="absolute inset-0 -z-10">
        <Img photo={c.photo} />
        <div className={`${scrimSide} to-scrim/40`} />
      </div>
      <div className="flex min-h-[70svh] flex-col justify-end px-gutter py-14 lg:py-20">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.address}
        </h2>
        <p className="mt-4 font-display text-2xl font-bold">{c.hours}</p>
        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
          <a href={c.ctaHref} className={cta}>
            {c.cta}
          </a>
          <a href={c.phoneHref} className={`min-h-12 content-center text-lg font-bold ${focus}`}>
            {c.phone}
          </a>
        </div>
      </div>
    </section>
  );
}

/** Content of nochnoy-produkt.footer. */
export type NFooterContent = {
  name: string;
  logo?: ReactNode;
  warranty: string;
  rating: { value: string; source: string };
  address: string;
  credits: readonly string[];
};

/** Footer: mark, trust line (warranty, rating, address), photo credits. */
export function NFooter({ content: c }: BlockProps<NFooterContent>) {
  return (
    <footer className="flex flex-col gap-4 px-gutter py-8 lg:flex-row lg:items-center lg:justify-between">
      <Logo c={c} />
      <p className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
        <span className="font-bold">{c.warranty}</span>
        <span>
          <span className="font-display text-xl font-bold text-accent-text">{c.rating.value}</span> в{" "}
          {c.rating.source}
        </span>
        <span>{c.address}</span>
      </p>
      <Credit list={c.credits} className="text-muted-foreground" />
    </footer>
  );
}
