// Булочная Терехова as a full site (grill-11, round 4): the chosen first screen П5 «Один хлеб» and below it what a
// visitor does on a bakery site: sorts and prices, a pre-order for the morning, shops and hours, reviews.
import { useState } from "react";
import type { PhotoSlot } from "../photos.js";
import { type Photo, rub } from "../still.js";
import { TerekhovLogo } from "./brand.js";
import { TEREKHOV as T } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-accent-strong ${focus}`;
const big = "font-display font-bold leading-[0.9] tracking-tight";

function Img({ photo, className }: { photo: Photo; className?: string }) {
  return (
    <img
      src={photo.src}
      alt={photo.alt}
      decoding="async"
      className={`size-full object-cover [filter:var(--ds-image-filter)] ${className ?? ""}`}
    />
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between gap-6 px-gutter py-5">
      <TerekhovLogo />
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-bold lg:flex">
        {T.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`underline-offset-4 hover:underline ${focus}`}>
            {n.label}
          </a>
        ))}
      </nav>
      <a href={T.phoneHref} className={`min-h-12 content-center text-sm font-bold ${focus}`}>
        {T.phone}
      </a>
    </header>
  );
}

function Rating({ className }: { className?: string }) {
  return (
    <p className={`flex items-baseline gap-2 text-sm ${className ?? ""}`}>
      <span className="font-display text-2xl font-bold">{T.rating.value}</span>
      {T.rating.count}, {T.rating.source}
    </p>
  );
}

function Points({ className }: { className?: string }) {
  return (
    <section aria-label="Где купить" className={`grid gap-6 sm:grid-cols-2 ${className ?? ""}`}>
      {T.points.map((p) => (
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

function Credit({ list, className }: { list: Photo[]; className?: string }) {
  return <p className={`text-sm ${className ?? ""}`}>Фото: {list.map((p) => p.credit).join(", ")}</p>;
}

/** First screen П5 «Один хлеб»: one loaf large, the «Т» score drawn over its crust as the brand. */
function Hero({ photos }: { photos: Photos }) {
  const p = photos["bakery-loaf"];
  return (
    <section className="flex min-h-svh flex-col">
      <Header />
      <div className="grid flex-1 lg:grid-cols-12">
        <figure className="relative m-0 h-[56svh] overflow-hidden lg:col-span-7 lg:h-auto">
          <div className="size-full bar-drift">
            <Img photo={p} />
          </div>
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
        </figure>
        <div className="flex flex-col px-gutter pt-8 pb-8 lg:col-span-5 lg:pt-4 lg:pl-12">
          <p className="text-sm font-bold uppercase tracking-widest">{T.loaf.kicker}</p>
          <h1 className="mt-4">
            <span
              className={`${big} block text-[calc(var(--ds-text-display)*1.05)] lg:text-[calc(var(--ds-text-display)*1.55)]`}
            >
              {T.loaf.name}
            </span>
            <span className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-display text-2xl font-bold lg:text-3xl">
              <span>{T.loaf.proof},</span>
              <span className="tabular-nums">{rub(T.loaf.price)}</span>
            </span>
          </h1>
          <p className="mt-6 max-w-text text-lg">{T.loaf.lead}</p>
          <p className="mt-3 text-sm">
            {T.loaf.weight}. <Rating className="inline-flex" />
          </p>
          <a href="#order" className={`${cta} mt-8 self-start`}>
            {T.loaf.cta}
          </a>
          <Points className="mt-auto pt-10" />
        </div>
      </div>
    </section>
  );
}

function Sorts({ photos }: { photos: Photos }) {
  const p = photos["bakery-crumb"];
  return (
    <section id="sorts" aria-labelledby="sorts-h" className="grid lg:grid-cols-12">
      <div className="px-gutter py-14 lg:col-span-7 lg:py-20">
        <h2
          id="sorts-h"
          className={`${big} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]`}
        >
          {T.sorts.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{T.sorts.lead}</p>
        <ul className="mt-10 border-t-2 border-current">
          {T.sorts.items.map((i) => (
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
      <figure className="m-0 h-[60svh] overflow-hidden lg:col-span-5 lg:h-auto">
        <Img photo={p} />
      </figure>
    </section>
  );
}

function Oven({ photos }: { photos: Photos }) {
  const p = photos["bakery-peel"];
  return (
    <section aria-label="Печь" className="relative isolate overflow-hidden text-scrim-foreground">
      <div className="absolute inset-0 -z-10">
        <Img photo={p} />
        <div className="absolute inset-0 bg-linear-to-t from-scrim via-scrim/60 to-scrim/10" />
      </div>
      <div className="flex min-h-[80svh] flex-col justify-end px-gutter py-12 lg:py-16">
        <p
          className={`${big} text-[calc(var(--ds-text-display)*2)] tabular-nums lg:text-[calc(var(--ds-text-display)*4)]`}
        >
          {T.oven.time}
        </p>
        <p className="mt-4 max-w-2xl font-display text-2xl font-bold lg:text-4xl">{T.oven.line}</p>
      </div>
    </section>
  );
}

function Order() {
  const [cart, setCart] = useState<Record<string, number>>({ wheat: 1 });
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(0);
  const [point, setPoint] = useState(0);
  const total = T.sorts.items.reduce((s, i) => s + i.price * (cart[i.id] ?? 0), 0);
  const count = Object.values(cart).reduce((s, n) => s + n, 0);
  const add = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }));
  const chip = (on: boolean) =>
    `min-h-11 rounded-control border px-3 text-sm font-bold tabular-nums ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"} ${focus}`;
  return (
    <section
      id="order"
      aria-labelledby="order-h"
      className="grid gap-10 bg-surface-alt px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-7">
        <h2
          id="order-h"
          className={`${big} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]`}
        >
          {T.order.title}
        </h2>
        <p className="mt-4 text-lg">{T.order.lead}</p>
        <ul className="mt-8 border-t-2 border-current">
          {T.sorts.items.map((i) => {
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
            {T.points.map((p, i) => (
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
            {T.order.days.map((d, i) => (
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
            {T.order.slots.map((s, i) => (
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
            {count} шт., {T.order.days[day]?.toLowerCase()} в {T.order.slots[slot]}
          </span>
          <span className="font-display text-3xl font-bold tabular-nums">{rub(total)}</span>
        </div>
        <button type="submit" className={cta}>
          Оформить предзаказ
        </button>
        <p className="text-sm">{T.order.note}</p>
      </form>
    </section>
  );
}

function Shops({ photos }: { photos: Photos }) {
  const p = photos["bakery-shelves"];
  return (
    <section id="points" aria-labelledby="points-h" className="grid lg:grid-cols-12">
      <figure className="m-0 h-[50svh] overflow-hidden lg:col-span-6 lg:h-auto">
        <Img photo={p} />
      </figure>
      <div className="px-gutter py-14 lg:col-span-6 lg:py-20 lg:pl-12">
        <h2
          id="points-h"
          className={`${big} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]`}
        >
          Две точки
        </h2>
        <p className="mt-4 text-lg">{T.city}. Печь на Ильинской, хлеб на обеих полках к открытию.</p>
        <Points className="mt-10 sm:grid-cols-1" />
        <a href={T.phoneHref} className={`${cta} mt-10`}>
          Позвонить {T.phone}
        </a>
      </div>
    </section>
  );
}

function Reviews() {
  return (
    <section id="reviews" aria-labelledby="reviews-h" className="px-gutter py-14 lg:py-20">
      <div className="flex flex-wrap items-baseline justify-between gap-6">
        <h2
          id="reviews-h"
          className={`${big} text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]`}
        >
          Отзывы
        </h2>
        <Rating className="text-base" />
      </div>
      <ul className="mt-10 grid gap-10 lg:grid-cols-3">
        {T.reviews.map((r) => (
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

const CREDITED: PhotoSlot[] = ["bakery-loaf", "bakery-crumb", "bakery-peel", "bakery-shelves"];

/** Site П5 «Один хлеб»: the first screen, then sorts and prices, oven, pre-order, shops and hours, reviews. */
export function BakeryLoaf({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      <Hero photos={photos} />
      <Sorts photos={photos} />
      <Oven photos={photos} />
      <Order />
      <Shops photos={photos} />
      <Reviews />
      <footer className="flex flex-col gap-4 border-t-2 border-current px-gutter py-8 lg:flex-row lg:items-center lg:justify-between">
        <TerekhovLogo />
        <p className="text-sm">
          {T.address}, {T.city}, {T.hours}
        </p>
        <Credit list={CREDITED.map((s) => photos[s])} />
      </footer>
    </div>
  );
}
