// Three first screens of Булочная Терехова, mood «Утро и пар» (grill-11, round 2). Each has its own composition:
// A «Пар» puts the bread photo on the whole screen and lets the headline run past the bottom edge; B «Часы» makes
// the oven time the typographic idea next to a portrait crop bleeding off the left; C «Вывеска» is the shop sign,
// a giant wordmark cut through by a letterbox photo.
import type { PhotoSlot } from "../photos.js";
import { type Photo, rub } from "../still.js";
import { TerekhovLogo, TerekhovMark } from "./brand.js";
import { TEREKHOV as T } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-accent-strong ${focus}`;

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

function Nav({ className }: { className?: string }) {
  return (
    <nav aria-label="Разделы" className={`hidden gap-8 text-sm font-bold lg:flex ${className ?? ""}`}>
      {T.nav.map((n) => (
        <a key={n} href={`#${n}`} className={`underline-offset-4 hover:underline ${focus}`}>
          {n}
        </a>
      ))}
    </nav>
  );
}

function Stars({ className }: { className?: string }) {
  return (
    <p className={`flex items-baseline gap-2 ${className ?? ""}`}>
      <span className="font-display text-3xl font-bold leading-none">{T.rating.value}</span>
      <span aria-hidden="true">★★★★★</span>
      <span className="text-sm">
        {T.rating.count}, {T.rating.source}
      </span>
    </p>
  );
}

function Credit({ photo, className }: { photo: Photo; className?: string }) {
  return <p className={`text-sm ${className ?? ""}`}>Фото: {photo.credit}</p>;
}

/** A «Пар»: full-bleed steam photo, almost no interface, the headline larger than the screen at the bottom. */
export function BakeryMorning({ photos }: { photos: Photos }) {
  const p = photos["bakery-steam"];
  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate flex min-h-svh flex-col overflow-hidden text-scrim-foreground">
        <div className="absolute inset-0 -z-10 bar-drift">
          <Img photo={p} />
        </div>
        <div className="absolute inset-0 -z-10 bg-linear-to-t from-scrim via-scrim/70 to-scrim/30" />
        <header className="flex items-center justify-between px-gutter pt-6">
          <TerekhovLogo />
          <Nav />
          <a
            href="#hold"
            className={`min-h-12 content-center border-b-2 border-current text-base font-bold ${focus}`}
          >
            {T.address}, до {T.hours.slice(-5)}
          </a>
        </header>
        <div className="mt-auto grid gap-8 px-gutter pb-8 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-5 lg:col-start-8">
            <Stars />
            <blockquote className="mt-4 max-w-text text-lg">
              «{T.review.text}»<footer className="mt-2 text-sm">{T.review.author}</footer>
            </blockquote>
            <p className="mt-6 max-w-text text-base">{T.hold.lead}</p>
            <a
              id="hold"
              href="#hold"
              className={`mt-6 inline-flex min-h-12 items-center rounded-control bg-surface px-6 text-base font-bold text-ink hover:bg-surface-alt ${focus}`}
            >
              {T.hold.cta} за {rub(T.hold.price)}
            </a>
          </div>
        </div>
        <h1 className="px-gutter pb-6 font-display text-[calc(var(--ds-text-display)*1.25)] lg:-mb-[0.1em] lg:pb-0 leading-[0.85] font-bold tracking-tight lg:text-[calc(var(--ds-text-display)*3.1)] lg:whitespace-nowrap">
          {T.hold.title}
        </h1>
      </section>
      <section aria-labelledby="bakes" className="bg-primary text-primary-foreground">
        <div className="flex flex-col gap-6 px-gutter py-10 lg:flex-row lg:items-baseline lg:gap-16">
          <h2 id="bakes" className="font-display text-2xl font-bold">
            Сегодня из печи
          </h2>
          <ol className="grid grid-cols-2 gap-x-10 gap-y-4 lg:flex lg:gap-16">
            {T.bakes.map((b) => (
              <li key={b.time}>
                <span className="block font-display text-3xl font-bold tabular-nums">{b.time}</span>
                <span className="text-sm">{b.name}</span>
              </li>
            ))}
          </ol>
        </div>
        <Credit photo={p} className="px-gutter pb-4" />
      </section>
    </div>
  );
}

/** B «Часы»: the oven time as giant numerals next to a portrait photo that bleeds off the left and top edges. */
export function BakeryClock({ photos }: { photos: Photos }) {
  const p = photos["bakery-peel"];
  const strip = [photos["bakery-crumb"], photos["bakery-window"], photos["bakery-morning-portrait"]];
  return (
    <div className="bg-background text-foreground">
      <section className="grid min-h-svh lg:grid-cols-12">
        <div className="relative h-[52svh] lg:col-span-5 lg:h-auto">
          <Img photo={p} />
          <div className="absolute top-6 left-gutter rounded-control bg-surface px-3 py-2 text-ink">
            <TerekhovLogo />
          </div>
        </div>
        <div className="flex flex-col px-gutter pt-6 pb-10 lg:col-span-7 lg:pl-16">
          <header className="flex items-center justify-end gap-8">
            <Nav />
            <a
              href={T.phoneHref}
              className={`min-h-12 content-center text-base font-bold tabular-nums ${focus}`}
            >
              {T.phone}
            </a>
          </header>
          <h1 className="mt-8 lg:mt-auto">
            <span className="block text-lg font-bold text-accent-text">{T.clock.kicker}</span>
            <span className="block font-display text-[calc(var(--ds-text-display)*3)] leading-[0.8] font-bold tracking-tight text-primary tabular-nums lg:text-[calc(var(--ds-text-display)*6)]">
              7:40
            </span>
          </h1>
          <div className="mt-8 grid gap-8 border-t border-line pt-8 lg:grid-cols-2">
            <div>
              <p className="max-w-text text-lg">{T.clock.lead}</p>
              <a href="#order" className={`${cta} mt-6`}>
                {T.clock.cta} за {rub(T.hold.price)}
              </a>
            </div>
            <figure className="m-0">
              <Stars className="text-foreground" />
              <blockquote className="mt-3 font-display text-xl">«{T.review.text}»</blockquote>
              <figcaption className="mt-2 text-sm text-muted-foreground">{T.review.author}</figcaption>
            </figure>
          </div>
        </div>
      </section>
      <section aria-label="Утро в булочной" className="grid grid-cols-3">
        {strip.map((s) => (
          <div key={s.src} className="h-40 lg:h-72">
            <Img photo={s} />
          </div>
        ))}
      </section>
      <p className="px-gutter py-3 text-sm text-muted-foreground">
        Фото: {[p, ...strip].map((s) => s.credit).join(", ")}
      </p>
    </div>
  );
}

/** C «Вывеска»: the name as a shop sign across the full width, a letterbox photo cutting through the letters. */
export function BakerySign({ photos }: { photos: Photos }) {
  const p = photos["bakery-window"];
  return (
    <div className="bg-background text-foreground">
      <section className="relative flex min-h-svh flex-col overflow-hidden">
        <header className="flex items-center justify-between px-gutter pt-6">
          <span className="inline-flex items-center gap-3 text-sm font-bold">
            <TerekhovMark className="size-10 text-primary" />
            {T.sign.since}
          </span>
          <Nav />
          <a href="#sub" className={`${cta}`}>
            {T.sign.cta}
          </a>
        </header>
        <h1 className="relative mt-10 text-center font-display leading-[0.78] font-bold text-primary lg:mt-6">
          <span className="block text-2xl lg:text-3xl">Булочная</span>
          <span className="relative z-0 -mb-[0.06em] block text-[calc(var(--ds-text-display)*2)] tracking-tight lg:text-[calc(var(--ds-text-display)*5.2)]">
            {T.short}
          </span>
        </h1>
        <div className="relative z-10 h-[34svh] lg:h-[38svh]">
          <Img photo={p} />
          <p className="absolute right-gutter bottom-4 rounded-control bg-surface px-3 py-2 text-sm text-ink">
            {T.address}, {T.hours}
          </p>
        </div>
        <div id="sub" className="grid gap-8 px-gutter py-8 lg:grid-cols-12 lg:items-end">
          <p className="font-display text-2xl lg:col-span-5">{T.sign.lead}</p>
          <dl className="grid grid-cols-3 gap-4 lg:col-span-5 lg:col-start-7">
            {T.sign.perks.map((k) => (
              <div key={k.label} className="border-t-2 border-primary pt-3">
                <dt className="text-sm text-muted-foreground">{k.label}</dt>
                <dd className="m-0 font-display text-2xl font-bold text-primary tabular-nums">{k.value}</dd>
              </div>
            ))}
          </dl>
          <Stars className="lg:col-span-2 lg:flex-col lg:items-end" />
        </div>
      </section>
      <section aria-labelledby="week" className="border-t border-line px-gutter py-10">
        <h2 id="week" className="font-display text-3xl font-bold">
          Неделя на вашем столе
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">Фото: {p.credit}</p>
      </section>
    </div>
  );
}
