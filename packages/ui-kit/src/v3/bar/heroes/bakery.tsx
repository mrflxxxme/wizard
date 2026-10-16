// Three first screens of Булочная Терехова (grill-11, round 3), each built on what a visitor does on a bakery site:
// П4 «Полка сегодня» checks what is left on the shelf and finds the shop; П5 «Один хлеб» is the signature loaf with
// the «Т» score as the brand; П6 «Предзаказ» is the order itself with the season banner above it.
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
          <a key={n} href={`#${n}`} className={`underline-offset-4 hover:underline ${focus}`}>
            {n}
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

function Credit({ photo, className }: { photo: Photo; className?: string }) {
  return <p className={`text-sm ${className ?? ""}`}>Фото: {photo.credit}</p>;
}

/** П4 «Полка сегодня»: the position line, one action, then today's shelf with prices and what is left. */
export function BakeryShelf({ photos }: { photos: Photos }) {
  const p = photos["bakery-shelves"];
  return (
    <div className="bg-background text-foreground">
      <section className="grid min-h-svh lg:grid-cols-12">
        <div className="flex flex-col lg:col-span-8">
          <Header />
          <div className="px-gutter pt-6 lg:pt-12">
            <h1
              className={`${big} max-w-[14ch] text-[calc(var(--ds-text-display)*1.05)] lg:text-[calc(var(--ds-text-display)*1.9)]`}
            >
              {T.shelf.title}
            </h1>
            <a href="#Как найти" className={`${cta} mt-8`}>
              {T.shelf.cta}
            </a>
          </div>
          <section aria-labelledby="shelf" className="mt-auto px-gutter pt-12 pb-8">
            <div className="flex items-baseline justify-between border-b-2 border-current pb-2">
              <h2 id="shelf" className="font-display text-xl font-bold">
                Сегодня на полке
              </h2>
              <span className="text-sm tabular-nums">{T.shelf.updated}</span>
            </div>
            <ul>
              {T.shelf.items.map((i) => (
                <li
                  key={i.name}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 border-b border-line py-3 lg:grid-cols-[1fr_6rem_14rem]"
                >
                  <span className="text-lg font-bold">{i.name}</span>
                  <span className="text-right text-lg tabular-nums">{rub(i.price)}</span>
                  <span className="col-span-2 flex items-center gap-3 text-sm lg:col-span-1">
                    <span aria-hidden="true" className="h-1.5 w-20 bg-line">
                      <span
                        className="block h-full bg-primary"
                        style={{ width: `${(i.left / i.of) * 100}%` }}
                      />
                    </span>
                    {i.left > 0 ? `осталось ${i.left} ${i.unit}` : "next" in i ? i.next : "закончился"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="relative flex min-h-[60svh] flex-col justify-end text-scrim-foreground lg:col-span-4 lg:min-h-0">
          <div className="absolute inset-0 -z-0 overflow-hidden">
            <div className="size-full bar-drift">
              <Img photo={p} />
            </div>
            <div className="absolute inset-0 bg-linear-to-t from-scrim via-scrim/60 to-transparent" />
          </div>
          <div id="Как найти" className="relative grid gap-5 px-gutter pb-8">
            <Rating />
            <Points className="sm:grid-cols-1" />
            <Credit photo={p} />
          </div>
        </aside>
      </section>
    </div>
  );
}

/** П5 «Один хлеб»: one loaf large, the «Т» score drawn over its crust as the brand; addresses below. */
export function BakeryLoaf({ photos }: { photos: Photos }) {
  const p = photos["bakery-loaf"];
  return (
    <div className="bg-background text-foreground">
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
        <Credit photo={p} className="px-gutter pb-4" />
      </section>
    </div>
  );
}

/** П6 «Предзаказ»: the season banner, then the order itself (add, day, pick-up time), then points and hours. */
export function BakeryOrder({ photos }: { photos: Photos }) {
  const p = photos["bakery-loaves"];
  const [cart, setCart] = useState<Record<string, number>>({ wheat: 1 });
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(0);
  const total = T.order.items.reduce((s, i) => s + i.price * (cart[i.id] ?? 0), 0);
  const count = Object.values(cart).reduce((s, n) => s + n, 0);
  const add = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }));
  const chip = (on: boolean) =>
    `min-h-11 rounded-control border px-3 text-sm font-bold tabular-nums ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"} ${focus}`;
  return (
    <div className="bg-background text-foreground">
      <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-primary px-gutter py-2 text-center text-sm font-bold text-primary-foreground">
        {T.order.season}
        <a href="#kulich" className={`underline underline-offset-4 ${focus}`}>
          {T.order.seasonCta}
        </a>
      </p>
      <Header />
      <section id="order" className="grid gap-10 px-gutter pt-4 pb-12 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h1
              className={`${big} text-[calc(var(--ds-text-display)*0.95)] lg:text-[calc(var(--ds-text-display)*1.4)]`}
            >
              {T.order.title}
            </h1>
            <Rating />
          </div>
          <ul className="mt-8 border-t-2 border-current">
            {T.order.items.map((i) => {
              const n = cart[i.id] ?? 0;
              return (
                <li
                  key={i.id}
                  id={i.id === "kulich" ? "kulich" : undefined}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 border-b border-line py-4 lg:grid-cols-[1fr_6rem_9rem]"
                >
                  <span>
                    <span className="block text-lg font-bold">{i.name}</span>
                    <span className="text-sm">{i.weight}</span>
                  </span>
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
          className="flex flex-col gap-5 lg:col-span-4 lg:col-start-9"
        >
          <figure className="m-0 hidden aspect-[4/3] overflow-hidden lg:block">
            <Img photo={p} />
          </figure>
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
          <div className="flex items-baseline justify-between border-t-2 border-current pt-3">
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
      <section aria-label="Точки" className="bg-surface-alt px-gutter py-10">
        <Points />
        <Credit photo={p} className="mt-6" />
      </section>
    </div>
  );
}
