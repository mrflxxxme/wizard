// Three first screens of Бокс 14, mood «Сервис как приложение» (grill-11, round 2): the screen is the product.
// A «Запись» is the booking itself with the live price by model; B «Чат» shows the repair as a master's chat with
// photos and an approval; C «Номер» starts from the licence plate and knows the car.
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

function Header({ action }: { action: string }) {
  return (
    <header className="flex items-center justify-between gap-6 px-gutter py-5">
      <Box14Logo />
      <nav aria-label="Разделы" className="hidden gap-8 text-sm font-bold lg:flex">
        {B.nav.map((n) => (
          <a key={n} href={`#${n}`} className={`hover:text-accent-text ${focus}`}>
            {n}
          </a>
        ))}
      </nav>
      <a href={B.phoneHref} className={`min-h-12 content-center text-sm font-bold ${focus}`}>
        {action}
      </a>
    </header>
  );
}

function Rating({ className }: { className?: string }) {
  return (
    <p className={`flex items-baseline gap-2 text-sm ${className ?? ""}`}>
      <span className="font-display text-2xl font-bold text-accent-text">{B.rating.value}</span>
      {B.rating.count} в {B.rating.source}
    </p>
  );
}

function Status() {
  return (
    <ol aria-label="Статус ремонта" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {B.status.map((s, i) => (
        <li
          key={s.step}
          className={`border-t-4 pt-3 ${s.done ? "border-ok" : i === 2 ? "border-accent" : "border-line"}`}
        >
          <span className="block text-sm text-muted-foreground tabular-nums">{s.time}</span>
          <span className="font-bold">{s.step}</span>
        </li>
      ))}
    </ol>
  );
}

/** A «Запись»: the booking panel is the hero; the price changes with the model before the visitor scrolls. */
export function ServiceBooking({ photos }: { photos: Photos }) {
  const [model, setModel] = useState<string>(FIRST.id);
  const [service, setService] = useState(0);
  const [slot, setSlot] = useState(0);
  const car = B.models.find((m) => m.id === model) ?? FIRST;
  const price = service === 1 ? car.brakes : service === 0 ? car.to : 2400;
  const p = photos["service-bay"];
  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate min-h-svh overflow-hidden">
        <div className="absolute inset-y-0 right-0 -z-10 hidden w-1/2 lg:block">
          <Img photo={p} />
          <div className="absolute inset-0 bg-linear-to-r from-background to-transparent" />
        </div>
        <Header action={B.phone} />
        <div className="grid gap-10 px-gutter pt-6 pb-10 lg:grid-cols-12 lg:pt-14">
          <div className="lg:col-span-6">
            <Rating />
            <h1
              className={`${big} mt-4 text-[calc(var(--ds-text-display)*1.1)] lg:text-[calc(var(--ds-text-display)*1.75)]`}
            >
              Бокс свободен сегодня в <span className="text-accent-text">{B.slots[slot]}</span>
            </h1>
            <p className="mt-6 max-w-text text-lg text-muted-foreground">{B.booking.lead}</p>
          </div>
          <form
            aria-label="Онлайн-запись"
            onSubmit={(e) => e.preventDefault()}
            className="rounded-lg border border-line bg-surface p-5 shadow-md lg:col-span-5 lg:col-start-8 lg:p-6"
          >
            <label className="block text-sm font-bold" htmlFor="model">
              Машина
            </label>
            <select
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={`mt-2 min-h-12 w-full rounded-control border border-border bg-background px-3 text-base ${focus}`}
            >
              {B.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <fieldset className="mt-5 border-0 p-0">
              <legend className="text-sm font-bold">Работа</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {B.services.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={service === i}
                    onClick={() => setService(i)}
                    className={chip(service === i)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="mt-5 border-0 p-0">
              <legend className="text-sm font-bold">Сегодня</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {B.slots.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={slot === i}
                    onClick={() => setSlot(i)}
                    className={`${chip(slot === i)} tabular-nums`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </fieldset>
            <p
              className="mt-6 flex items-baseline justify-between border-t border-line pt-4"
              aria-live="polite"
            >
              <span className="text-sm text-muted-foreground">
                {car.label}, {service === 0 ? car.hours : "по факту осмотра"}
              </span>
              <output className="font-display text-3xl font-bold tabular-nums">{rub(price)}</output>
            </p>
            <button type="submit" className={`${cta} mt-4 w-full`}>
              Записаться на {B.slots[slot]}
            </button>
          </form>
        </div>
      </section>
      <section aria-labelledby="status" className="border-t border-line px-gutter py-10">
        <h2 id="status" className="mb-6 font-display text-xl font-bold">
          Статус ремонта в реальном времени
        </h2>
        <Status />
        <p className="mt-6 text-sm text-muted-foreground">Фото: {p.credit}</p>
      </section>
    </div>
  );
}

/** B «Чат»: the master's chat on a phone-width column, photo of the worn disc and the approve button. */
export function ServiceChat({ photos }: { photos: Photos }) {
  const work = photos["service-detail"];
  const bay = photos["service-mechanic"];
  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate min-h-svh overflow-hidden">
        <Header action="Открыть чат" />
        <div className="grid gap-10 px-gutter pt-4 pb-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-6">
            <h1
              className={`${big} text-[calc(var(--ds-text-display)*1.05)] lg:text-[calc(var(--ds-text-display)*1.3)]`}
            >
              {B.chat.title}
            </h1>
            <p className="mt-6 max-w-text text-lg text-muted-foreground">{B.chat.lead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-6">
              <a href="#Запись" className={cta}>
                Записаться и получить чат
              </a>
              <Rating />
            </div>
          </div>
          <div className="relative lg:col-span-5 lg:col-start-8">
            <div className="absolute -inset-x-gutter -inset-y-10 -z-10 hidden lg:block">
              <Img photo={bay} className="opacity-40" />
            </div>
            <div
              role="log"
              aria-label="Чат с мастером"
              className="mx-auto max-w-sm rounded-lg border border-line bg-surface p-4 shadow-md"
            >
              <p className="flex justify-between border-b border-line pb-3 text-sm">
                <span className="font-bold">{B.chat.master}</span>
                <span className="text-muted-foreground">{B.chat.car}</span>
              </p>
              <p className="mt-4 max-w-[85%] rounded-md bg-surface-alt p-3 text-sm">{B.chat.messages[0]}</p>
              <div className="mt-2 h-44 max-w-[85%] overflow-hidden rounded-md">
                <Img photo={work} />
              </div>
              <p className="mt-2 max-w-[85%] rounded-md bg-surface-alt p-3 text-sm">{B.chat.messages[1]}</p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button type="button" className={`${cta} px-3 text-sm`}>
                  Согласовать {rub(9600)}
                </button>
                <button type="button" className={`${chip(false)} min-h-12`}>
                  Позвонить
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section aria-labelledby="status2" className="bg-surface-alt px-gutter py-10">
        <h2 id="status2" className="mb-6 font-display text-xl font-bold">
          Kia K5 на подъёмнике, бокс 14
        </h2>
        <Status />
        <p className="mt-6 text-sm text-muted-foreground">
          Фото: {work.credit}, {bay.credit}
        </p>
      </section>
    </div>
  );
}

/** C «Номер»: a licence plate as the input, the car recognised, the next service with a price. */
export function ServicePlate({ photos }: { photos: Photos }) {
  const p = photos["service-car"];
  const car = FIRST;
  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate grid min-h-svh grid-rows-[auto_1fr] overflow-hidden">
        <Header action="Войти по номеру" />
        <div className="grid lg:grid-cols-12">
          <div className="flex min-w-0 flex-col justify-center px-gutter pb-10 lg:col-span-6">
            <h1 className={`${big} text-2xl lg:text-[calc(var(--ds-text-display)*1.2)]`}>{B.plate.title}</h1>
            <label htmlFor="plate" className="mt-8 block text-sm font-bold">
              {B.plate.label}
            </label>
            <div className="mt-2 flex w-fit items-stretch overflow-hidden rounded-md border-4 border-ink bg-surface text-ink">
              <input
                id="plate"
                defaultValue={B.plate.number}
                className={`w-[7.2ch] bg-transparent px-3 font-display text-2xl font-bold uppercase sm:text-3xl lg:text-[calc(var(--ds-text-display)*0.95)] ${focus}`}
              />
              <span className="flex flex-col items-center justify-center border-l-4 border-ink px-3 font-display text-2xl font-bold">
                {B.plate.region}
                <span className="text-sm font-normal">RUS</span>
              </span>
            </div>
            <dl className="mt-8 grid gap-4 border-t border-line pt-6 lg:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Машина</dt>
                <dd className="m-0 text-lg font-bold">{B.plate.car}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">История</dt>
                <dd className="m-0 text-lg font-bold">{B.plate.history}</dd>
              </div>
            </dl>
            <div className="mt-8 flex flex-wrap items-center gap-6">
              <a href="#Запись" className={cta}>
                {B.plate.cta} за {rub(car.to)}
              </a>
              <Rating />
            </div>
          </div>
          <div className="relative min-h-72 lg:col-span-6">
            <Img photo={p} />
            <p className="absolute bottom-6 left-6 rounded-md bg-accent px-4 py-3 font-bold text-accent-ink">
              {B.plate.due}
            </p>
          </div>
        </div>
      </section>
      <section aria-labelledby="prices" className="border-t border-line px-gutter py-10">
        <h2 id="prices" className="font-display text-xl font-bold">
          ТО по регламенту, цена с работой
        </h2>
        <ul className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-5">
          {B.models.map((m) => (
            <li key={m.id} className="border-t border-line pt-3">
              <span className="block text-sm text-muted-foreground">{m.label}</span>
              <span className="font-display text-xl font-bold tabular-nums">{rub(m.to)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-muted-foreground">Фото: {p.credit}</p>
      </section>
    </div>
  );
}
