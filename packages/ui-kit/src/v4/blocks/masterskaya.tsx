// Blocks of the direction «Мастерская» (grill-11 (1)), cut from the accepted bakery site П5 «Один хлеб» (round 4).
// Each block renders one section from its content; the section markup is the accepted site's.
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Credit, focus, Img, type Photo, rub, useStill } from "./kit.js";
import type { BlockProps } from "./types.js";

const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-accent-strong ${focus}`;
const big = "font-display font-bold leading-[0.9] tracking-tight";
const h2 = `${big} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]`;

export type NavLink = { id: string; label: string };
export type Rating = { value: string; count: string; source: string };
export type Point = { address: string; hours: string; note: string };
export type Sort = { id: string; name: string; weight: string; price: number; note: string };

/** Content of masterskaya.header. */
export type MHeaderContent = {
  name: string;
  logo?: ReactNode;
  nav: readonly NavLink[];
  phone: string;
  phoneHref: string;
};

/** Name in the display face when the business has no mark yet. */
const Logo = ({ c }: { c: { name: string; logo?: ReactNode } }) =>
  c.logo ?? <span className="font-display text-xl leading-none">{c.name}</span>;

/** Header: mark, anchors to the sections (desktop), phone. */
export function MHeader({ content: c }: BlockProps<MHeaderContent>) {
  return (
    <header className="flex items-center justify-between gap-6 px-gutter py-5">
      <Logo c={c} />
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-bold lg:flex">
        {c.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`underline-offset-4 hover:underline ${focus}`}>
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

function RatingLine({ r, className }: { r: Rating; className?: string }) {
  return (
    <p className={`flex items-baseline gap-2 text-sm ${className ?? ""}`}>
      <span className="font-display text-2xl font-bold">{r.value}</span>
      {r.count}, {r.source}
    </p>
  );
}

function Points({ points, className }: { points: readonly Point[]; className?: string }) {
  return (
    <section aria-label="Где купить" className={`grid gap-6 sm:grid-cols-2 ${className ?? ""}`}>
      {points.map((p) => (
        <div key={p.address} className="border-t-2 border-current pt-3">
          <p className="font-display text-2xl font-bold">{p.address}</p>
          <p className="mt-1 text-base">
            <span className="tabular-nums">{p.hours}</span>, {p.note}
          </p>
        </div>
      ))}
    </section>
  );
}

/** Content of masterskaya.hero. */
export type MHeroContent = {
  header: MHeaderContent;
  photo: Photo;
  kicker: string;
  name: string;
  proof: string;
  price: number;
  lead: string;
  weight: string;
  rating: Rating;
  cta: string;
  ctaHref: string;
  points: readonly Point[];
};

/** «Один хлеб»: one product large with the brand score over its crust, its proof and price, one action, the shops. */
export function MHero({ content: c, variant }: BlockProps<MHeroContent>) {
  return (
    <section className="flex min-h-svh flex-col">
      <MHeader content={c.header} />
      <div className="grid flex-1 lg:grid-cols-12">
        <figure className="relative m-0 h-[56svh] overflow-hidden lg:col-span-7 lg:h-auto">
          <div className="size-full bar-drift">
            <Img photo={c.photo} filter />
          </div>
          {variant === "plain" ? null : (
            <svg
              viewBox="0 0 100 100"
              aria-hidden="true"
              className="absolute top-1/2 left-1/2 w-[38%] -translate-x-1/2 -translate-y-1/2 rotate-[50deg] text-scrim-foreground opacity-85"
            >
              <path
                d="M18 24 Q50 17 82 24 M50 22 Q47 56 51 88"
                fill="none"
                stroke="currentColor"
                strokeWidth="5"
                strokeLinecap="round"
              />
            </svg>
          )}
        </figure>
        <div className="flex flex-col px-gutter pt-8 pb-8 lg:col-span-5 lg:pt-4 lg:pl-12">
          <p className="text-sm font-bold uppercase tracking-widest">{c.kicker}</p>
          <h1 className="mt-4">
            <span
              className={`${big} block text-[calc(var(--ds-text-display)*1.05)] lg:text-[calc(var(--ds-text-display)*1.55)]`}
            >
              {c.name}
            </span>
            <span className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-display text-2xl font-bold lg:text-3xl">
              <span>{c.proof},</span>
              <span className="tabular-nums">{rub(c.price)}</span>
            </span>
          </h1>
          <p className="mt-6 max-w-text text-lg">{c.lead}</p>
          <p className="mt-3 text-sm">
            {c.weight}. <RatingLine r={c.rating} className="inline-flex" />
          </p>
          <a href={c.ctaHref} className={`${cta} mt-8 self-start`}>
            {c.cta}
          </a>
          <Points points={c.points} className="mt-auto pt-10" />
        </div>
      </div>
    </section>
  );
}

/** Content of masterskaya.menu. */
export type MMenuContent = {
  anchor: string;
  title: string;
  lead: string;
  items: readonly Sort[];
  photo: Photo;
};

/** «Хлеб и цены»: rows of name, weight and note against a large price; a crumb photo to the side. */
export function MMenu({ content: c, variant }: BlockProps<MMenuContent>) {
  const figure = (
    <figure className="m-0 h-[60svh] overflow-hidden lg:col-span-5 lg:h-auto">
      <Img photo={c.photo} filter />
    </figure>
  );
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="grid lg:grid-cols-12">
      {variant === "photo-left" ? figure : null}
      <div className="px-gutter py-14 lg:col-span-7 lg:py-20">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{c.lead}</p>
        <ul className="mt-10 border-t-2 border-current">
          {c.items.map((i) => (
            <li
              key={i.id}
              className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 border-b border-line py-4"
            >
              <span>
                <span className="block font-display text-2xl font-bold lg:text-3xl">{i.name}</span>
                <span className="text-sm">
                  {i.weight}, {i.note}
                </span>
              </span>
              <span className="font-display text-2xl font-bold tabular-nums lg:text-3xl">{rub(i.price)}</span>
            </li>
          ))}
        </ul>
      </div>
      {variant === "photo-left" ? null : figure}
    </section>
  );
}

/** Content of masterskaya.moment. */
export type MMomentContent = { label: string; time: string; line: string; photo: Photo };

/**
 * Signature moment of «Мастерская»: the hour of the oven over a full-bleed photo. On a wide screen with motion allowed
 * the digits rise from under an edge and the line follows; on 390 px and with reduced motion the final frame stands.
 */
export function MMoment({ content: c }: BlockProps<MMomentContent>) {
  const still = useStill();
  const rise = still
    ? {}
    : {
        initial: { y: "100%" },
        whileInView: { y: "0%" },
        viewport: { once: true, amount: 0.6 },
        transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] as const },
      };
  const show = still
    ? {}
    : {
        initial: { opacity: 0 },
        whileInView: { opacity: 1 },
        viewport: { once: true, amount: 0.6 },
        transition: { duration: 0.6, delay: 0.5 },
      };
  return (
    <section aria-label={c.label} className="relative isolate overflow-hidden text-scrim-foreground">
      <div className="absolute inset-0 -z-10">
        <Img photo={c.photo} filter />
        <div className="absolute inset-0 bg-linear-to-t from-scrim via-scrim/60 to-scrim/10" />
      </div>
      <div className="flex min-h-[80svh] flex-col justify-end px-gutter py-12 lg:py-16">
        <p
          className={`${big} text-[calc(var(--ds-text-display)*2)] tabular-nums lg:text-[calc(var(--ds-text-display)*4)]`}
        >
          <motion.span key={still ? "still" : "rise"} className="block" {...rise}>
            {c.time}
          </motion.span>
        </p>
        <motion.p
          key={still ? "still" : "show"}
          className="mt-4 max-w-2xl font-display text-2xl font-bold lg:text-4xl"
          {...show}
        >
          {c.line}
        </motion.p>
      </div>
    </section>
  );
}

/** Content of masterskaya.order. */
export type MOrderContent = {
  anchor: string;
  title: string;
  lead: string;
  items: readonly Sort[];
  /** Id of the item in the basket at the start. */
  preset?: string;
  points: readonly Point[];
  days: readonly string[];
  slots: readonly string[];
  submit: string;
  note: string;
};

/** «Предзаказ к утру»: basket over the price list, shop, day and hour as chips, the sum and one submit. */
export function MOrder({ content: c }: BlockProps<MOrderContent>) {
  const [cart, setCart] = useState<Record<string, number>>(c.preset ? { [c.preset]: 1 } : {});
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(0);
  const [point, setPoint] = useState(0);
  const total = c.items.reduce((s, i) => s + i.price * (cart[i.id] ?? 0), 0);
  const count = Object.values(cart).reduce((s, n) => s + n, 0);
  const add = (id: string, d: number) => setCart((x) => ({ ...x, [id]: Math.max(0, (x[id] ?? 0) + d) }));
  const chip = (on: boolean) =>
    `min-h-11 rounded-control border px-3 text-sm font-bold tabular-nums ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"} ${focus}`;
  return (
    <section
      id={c.anchor}
      aria-labelledby={`${c.anchor}-h`}
      className="grid gap-10 bg-surface-alt px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-7">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-4 text-lg">{c.lead}</p>
        <ul className="mt-8 border-t-2 border-current">
          {c.items.map((i) => {
            const n = cart[i.id] ?? 0;
            return (
              <li
                key={i.id}
                className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 border-b border-line py-3 lg:grid-cols-[1fr_6rem_9rem]"
              >
                <span className="text-lg font-bold">{i.name}</span>
                <span className="text-right text-lg tabular-nums">{rub(i.price)}</span>
                {n === 0 ? (
                  <button
                    type="button"
                    onClick={() => add(i.id, 1)}
                    className={`col-span-2 min-h-11 rounded-control border-2 border-primary px-4 text-sm font-bold lg:col-span-1 ${focus}`}
                  >
                    Добавить
                  </button>
                ) : (
                  <span className="col-span-2 flex items-center justify-between gap-2 lg:col-span-1">
                    <button
                      type="button"
                      aria-label={`Убрать: ${i.name}`}
                      onClick={() => add(i.id, -1)}
                      className={chip(false)}
                    >
                      −
                    </button>
                    <span className="font-bold tabular-nums" aria-live="polite">
                      {n}
                    </span>
                    <button
                      type="button"
                      aria-label={`Добавить: ${i.name}`}
                      onClick={() => add(i.id, 1)}
                      className={chip(false)}
                    >
                      +
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <form
        aria-label="Когда забрать"
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-col gap-5 lg:col-span-4 lg:col-start-9 lg:pt-4"
      >
        <fieldset className="border-0 p-0">
          <legend className="text-sm font-bold">Где забрать</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {c.points.map((p, i) => (
              <button
                key={p.address}
                type="button"
                aria-pressed={point === i}
                onClick={() => setPoint(i)}
                className={chip(point === i)}
              >
                {p.address}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="border-0 p-0">
          <legend className="text-sm font-bold">Когда забрать</legend>
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
          <div className="mt-2 flex flex-wrap gap-2">
            {c.slots.map((s, i) => (
              <button
                key={s}
                type="button"
                aria-pressed={slot === i}
                onClick={() => setSlot(i)}
                className={chip(slot === i)}
              >
                {s}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex items-baseline justify-between gap-4 border-t-2 border-current pt-3">
          <span className="text-sm">
            {count} шт., {c.days[day]?.toLowerCase()} в {c.slots[slot]}
          </span>
          <span className="font-display text-3xl font-bold tabular-nums">{rub(total)}</span>
        </div>
        <button type="submit" className={cta}>
          {c.submit}
        </button>
        <p className="text-sm">{c.note}</p>
      </form>
    </section>
  );
}

/** Content of masterskaya.locations. */
export type MLocationsContent = {
  anchor: string;
  title: string;
  lead: string;
  points: readonly Point[];
  photo: Photo;
  cta: string;
  ctaHref: string;
};

/** «Две точки»: shelves photo to one side, addresses with hours and a call to the other. */
export function MLocations({ content: c, variant }: BlockProps<MLocationsContent>) {
  const figure = (
    <figure className="m-0 h-[50svh] overflow-hidden lg:col-span-6 lg:h-auto">
      <Img photo={c.photo} filter />
    </figure>
  );
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="grid lg:grid-cols-12">
      {variant === "photo-right" ? null : figure}
      <div className="px-gutter py-14 lg:col-span-6 lg:py-20 lg:pl-12">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <p className="mt-4 text-lg">{c.lead}</p>
        <Points points={c.points} className="mt-10 sm:grid-cols-1" />
        <a href={c.ctaHref} className={`${cta} mt-10`}>
          {c.cta}
        </a>
      </div>
      {variant === "photo-right" ? figure : null}
    </section>
  );
}

/** Content of masterskaya.reviews. */
export type MReviewsContent = {
  anchor: string;
  title: string;
  rating: Rating;
  items: readonly { name: string; when: string; text: string }[];
};

/** Reviews: the rating with its count and source, three quotes set large in the display face. */
export function MReviews({ content: c }: BlockProps<MReviewsContent>) {
  return (
    <section id={c.anchor} aria-labelledby={`${c.anchor}-h`} className="px-gutter py-14 lg:py-20">
      <div className="flex flex-wrap items-baseline justify-between gap-6">
        <h2 id={`${c.anchor}-h`} className={h2}>
          {c.title}
        </h2>
        <RatingLine r={c.rating} className="text-base" />
      </div>
      <ul className="mt-10 grid gap-10 lg:grid-cols-3">
        {c.items.map((r) => (
          <li key={r.name} className="border-t-2 border-current pt-4">
            <blockquote className="m-0 font-display text-2xl font-bold leading-snug">«{r.text}»</blockquote>
            <p className="mt-3 text-sm">
              {r.name}, {r.when}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Content of masterskaya.footer. */
export type MFooterContent = { name: string; logo?: ReactNode; line: string; credits: readonly string[] };

/** Footer: mark, address and hours, photo credits. */
export function MFooter({ content: c }: BlockProps<MFooterContent>) {
  return (
    <footer className="flex flex-col gap-4 border-t-2 border-current px-gutter py-8 lg:flex-row lg:items-center lg:justify-between">
      <Logo c={c} />
      <p className="text-sm">{c.line}</p>
      <Credit list={c.credits} />
    </footer>
  );
}
