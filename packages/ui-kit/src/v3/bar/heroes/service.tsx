// Бокс 14 as a full site (grill-11, round 4): the chosen first screen С5 «Опишите проблему» and below it what a
// visitor does on a car service site: prices «от» for the car, booking a time, repair status with photos in the chat,
// reviews and the address.
import { useState } from "react";
import type { PhotoSlot } from "../photos.js";
import { type Photo, rub } from "../still.js";
import { Box14Logo } from "./brand.js";
import { BOX14 as B, type CarModel } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
const FIRST = B.models[0] as CarModel;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const cta = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-base font-bold text-primary-foreground hover:bg-accent-strong ${focus}`;
const chip = (on: boolean) =>
  `min-h-11 rounded-control border px-3 text-sm font-bold ${on ? "border-accent bg-accent text-accent-ink" : "border-border text-foreground"} ${focus}`;
const big = "font-display font-bold leading-[0.95] tracking-tight";
const h2 =
  "font-display font-bold leading-[0.95] tracking-tight text-[calc(var(--ds-text-display)*0.85)] lg:text-[calc(var(--ds-text-display)*1.2)]";
const field = `mt-2 min-h-12 w-full rounded-control border border-border bg-background px-3 text-base ${focus}`;

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

function Header() {
  return (
    <header className="flex items-center justify-between gap-6 px-gutter py-5">
      <Box14Logo />
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-bold lg:flex">
        {B.nav.map((n) => (
          <a key={n.id} href={`#${n.id}`} className={`hover:text-accent-text ${focus}`}>
            {n.label}
          </a>
        ))}
      </nav>
      <a href={B.phoneHref} className={`min-h-12 content-center text-sm font-bold ${focus}`}>
        {B.phone}
      </a>
    </header>
  );
}

/** Trust line: warranty, rating, address. */
function Trust({ className }: { className?: string }) {
  return (
    <p className={`flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm ${className ?? ""}`}>
      <span className="font-bold">Гарантия 1 год</span>
      <span>
        <span className="font-display text-xl font-bold text-accent-text">{B.rating.value}</span> в{" "}
        {B.rating.source}
      </span>
      <span>{B.address}</span>
    </p>
  );
}

function Credit({ list, className }: { list: Photo[]; className?: string }) {
  return (
    <p className={`text-sm text-muted-foreground ${className ?? ""}`}>
      Фото: {list.map((p) => p.credit).join(", ")}
    </p>
  );
}

/** First screen С5 «Опишите проблему»: one field for a quote, numbers of trust under it. */
function Hero({ photos }: { photos: Photos }) {
  const p = photos["service-mechanic"];
  return (
    <section className="relative isolate overflow-hidden text-scrim-foreground">
      <div className="absolute inset-0 -z-10">
        <Img photo={p} />
        <div className="absolute inset-0 bg-linear-to-r from-scrim via-scrim/85 to-scrim/50" />
      </div>
      <Header />
      <div className="px-gutter pt-8 pb-12 lg:pt-16 lg:pb-16">
        <h1
          className={`${big} text-[calc(var(--ds-text-display)*1.1)] lg:text-[calc(var(--ds-text-display)*2)]`}
        >
          {B.ask.title}
        </h1>
        <form
          aria-label="Расчёт ремонта"
          onSubmit={(e) => e.preventDefault()}
          className="mt-8 flex max-w-5xl flex-col gap-3 lg:flex-row"
        >
          <label htmlFor="problem" className="sr-only">
            Опишите машину и проблему
          </label>
          <input
            id="problem"
            type="text"
            placeholder={B.ask.placeholder}
            className={`min-h-16 flex-1 rounded-control border-2 border-border bg-background px-5 text-xl text-foreground ${focus}`}
          />
          <button type="submit" className={`${cta} min-h-16 text-lg`}>
            {B.ask.cta}
          </button>
        </form>
        <p className="mt-3 text-base">{B.ask.lead}</p>
        <dl className="mt-10 grid grid-cols-3 gap-6 lg:max-w-3xl">
          {[
            { v: B.rating.value, l: `в ${B.rating.source}` },
            { v: B.repairs, l: "ремонтов" },
            { v: "1 год", l: "гарантия" },
          ].map((n) => (
            <div key={n.l} className="border-t-2 border-current pt-2">
              <dt className="sr-only">{n.l}</dt>
              <dd className="m-0 font-display text-3xl font-bold tabular-nums lg:text-5xl">{n.v}</dd>
              <dd className="m-0 text-sm">{n.l}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Prices() {
  const [model, setModel] = useState<string>(FIRST.id);
  const car = B.models.find((m) => m.id === model) ?? FIRST;
  return (
    <section
      id="prices"
      aria-labelledby="prices-h"
      className="grid gap-10 px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-5">
        <h2 id="prices-h" className={h2}>
          {B.prices.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{B.prices.lead}</p>
        <label className="mt-8 block text-sm font-bold">
          Машина
          <select value={model} onChange={(e) => setModel(e.target.value)} className={field}>
            {B.models.map((m) => (
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
          {B.jobs.map((j, i) => (
            <li key={j} className="flex items-baseline justify-between gap-4 border-b border-line py-3">
              <span className="text-lg">{j}</span>
              <span className="font-display text-2xl font-bold tabular-nums">
                от {rub(car.prices[i] ?? 0)}
              </span>
            </li>
          ))}
        </ul>
        <a href="#book" className={`${cta} mt-8`}>
          Записаться на время
        </a>
      </div>
    </section>
  );
}

function Book() {
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(0);
  return (
    <section id="book" aria-labelledby="book-h" className="bg-surface-alt px-gutter py-14 lg:py-20">
      <h2 id="book-h" className={h2}>
        {B.book.title}
      </h2>
      <form
        aria-label="Запись"
        onSubmit={(e) => e.preventDefault()}
        className="mt-8 grid gap-6 lg:grid-cols-12"
      >
        <fieldset className="border-0 p-0 lg:col-span-7">
          <legend className="text-sm font-bold">День и время</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {B.book.days.map((d, i) => (
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
            {B.book.slots.map((s, i) => {
              const busy = day === 0 && (B.book.busy as readonly string[]).includes(s);
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
            {B.book.days[day]}, {B.book.slots[slot]}
          </p>
          <p className="text-sm">{B.address}, бокс выдаём по номеру записи.</p>
          <button type="submit" className={cta}>
            {B.book.cta} на {B.book.slots[slot]}
          </button>
          <p className="text-sm text-muted-foreground">{B.book.note}</p>
        </div>
      </form>
    </section>
  );
}

function Status({ photos }: { photos: Photos }) {
  const part = photos["service-under-car"];
  const s = B.status;
  return (
    <section
      id="status"
      aria-labelledby="status-h"
      className="grid gap-10 px-gutter py-14 lg:grid-cols-12 lg:py-20"
    >
      <div className="lg:col-span-5">
        <h2 id="status-h" className={h2}>
          {s.title}
        </h2>
        <p className="mt-4 max-w-text text-lg">{s.lead}</p>
        <p className="mt-8 text-sm font-bold">{s.car}</p>
        <ol className="mt-3 grid grid-cols-4 gap-2">
          {s.stages.map((st, i) => (
            <li
              key={st}
              aria-current={i === s.current ? "step" : undefined}
              className={`border-t-4 pt-2 text-sm ${i <= s.current ? "border-accent font-bold" : "border-line text-muted-foreground"}`}
            >
              {st}
            </li>
          ))}
        </ol>
      </div>
      <ul aria-label="Чат с мастером" className="flex flex-col gap-4 lg:col-span-6 lg:col-start-7">
        {s.chat.map((m) => (
          <li
            key={m.time}
            className={`max-w-[85%] border-l-4 pl-4 ${m.who === "client" ? "self-end border-accent" : "border-line"}`}
          >
            <p className="text-sm text-muted-foreground">
              {m.who === "client" ? "Вы" : "Мастер Денис"}, {m.time}
            </p>
            {"photo" in m ? (
              <figure className="m-0 mt-2 aspect-[4/3] overflow-hidden">
                <Img photo={part} />
              </figure>
            ) : null}
            <p className="mt-1 text-lg">{m.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function How() {
  return (
    <section aria-labelledby="how" className="border-t-2 border-current px-gutter py-14 lg:py-20">
      <h2 id="how" className={h2}>
        Как это работает
      </h2>
      <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {B.ask.steps.map((st) => (
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

function Reviews() {
  return (
    <section aria-labelledby="reviews-h" className="bg-surface-alt px-gutter py-14 lg:py-20">
      <div className="flex flex-wrap items-baseline justify-between gap-6">
        <h2 id="reviews-h" className={h2}>
          Отзывы
        </h2>
        <p className="text-base">
          <span className="font-display text-3xl font-bold text-accent-text">{B.rating.value}</span> в{" "}
          {B.rating.source}, {B.repairs} ремонтов
        </p>
      </div>
      <ul className="mt-10 grid gap-10 lg:grid-cols-3">
        {B.reviews.map((r) => (
          <li key={r.name} className="border-t-2 border-current pt-4">
            <blockquote className="m-0 text-xl font-bold leading-snug">«{r.text}»</blockquote>
            <p className="mt-3 text-sm">{r.name}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Contacts({ photos }: { photos: Photos }) {
  const p = photos["service-bay"];
  return (
    <section
      id="contacts"
      aria-labelledby="contacts-h"
      className="relative isolate overflow-hidden text-scrim-foreground"
    >
      <div className="absolute inset-0 -z-10">
        <Img photo={p} />
        <div className="absolute inset-0 bg-linear-to-r from-scrim via-scrim/85 to-scrim/40" />
      </div>
      <div className="flex min-h-[70svh] flex-col justify-end px-gutter py-14 lg:py-20">
        <h2 id="contacts-h" className={h2}>
          {B.address}
        </h2>
        <p className="mt-4 font-display text-2xl font-bold">{B.hours}</p>
        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
          <a href="#book" className={cta}>
            Записаться
          </a>
          <a href={B.phoneHref} className={`min-h-12 content-center text-lg font-bold ${focus}`}>
            {B.phone}
          </a>
        </div>
      </div>
    </section>
  );
}

const CREDITED: PhotoSlot[] = ["service-mechanic", "service-under-car", "service-bay"];

/** Site С5 «Опишите проблему»: the first screen, then prices for the car, booking, repair status, reviews, address. */
export function ServiceAsk({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      <Hero photos={photos} />
      <Prices />
      <Book />
      <Status photos={photos} />
      <How />
      <Reviews />
      <Contacts photos={photos} />
      <footer className="flex flex-col gap-4 px-gutter py-8 lg:flex-row lg:items-center lg:justify-between">
        <Box14Logo />
        <Trust />
        <Credit list={CREDITED.map((s) => photos[s])} />
      </footer>
    </div>
  );
}
