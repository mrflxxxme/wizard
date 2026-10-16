// Three first screens of Бокс 14 (grill-11, round 3): the first screen is the tool a visitor uses on a car service
// site. С4 «Подбор по машине» picks brand, model and job and shows prices «от»; С5 «Опишите проблему» is one field
// for a quote; С6 «Госномер и акция» leads with the offer of the month and a plate field with categories.
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
          <a key={n} href={`#${n}`} className={`hover:text-accent-text ${focus}`}>
            {n}
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

function Credit({ photo, className }: { photo: Photo; className?: string }) {
  return <p className={`text-sm text-muted-foreground ${className ?? ""}`}>Фото: {photo.credit}</p>;
}

/** С4 «Подбор по машине»: brand, model and job, and the prices «от» for exactly this car. */
export function ServicePick({ photos }: { photos: Photos }) {
  const [brand, setBrand] = useState<string>(B.brands[0]);
  const [model, setModel] = useState<string>(FIRST.id);
  const [job, setJob] = useState(0);
  const car = B.models.find((m) => m.id === model) ?? FIRST;
  const p = photos["service-bay"];
  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate min-h-svh overflow-hidden">
        <div className="absolute inset-y-0 right-0 -z-10 hidden w-5/12 lg:block">
          <div className="size-full bar-drift">
            <Img photo={p} />
          </div>
        </div>
        <div className="lg:w-7/12">
          <Header />
          <div className="px-gutter pt-4 pb-10 lg:pt-10 lg:pr-16">
            <h1
              className={`${big} text-[calc(var(--ds-text-display)*1.1)] lg:text-[calc(var(--ds-text-display)*1.8)]`}
            >
              {B.book.title}
            </h1>
            <form aria-label="Подбор по машине" onSubmit={(e) => e.preventDefault()} className="mt-8">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-bold">
                  Марка
                  <select value={brand} onChange={(e) => setBrand(e.target.value)} className={field}>
                    {B.brands.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-bold">
                  Модель
                  <select value={model} onChange={(e) => setModel(e.target.value)} className={field}>
                    {B.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="mt-5 border-0 p-0">
                <legend className="text-sm font-bold">Работа</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {B.jobs.map((j, i) => (
                    <button
                      key={j}
                      type="button"
                      aria-pressed={job === i}
                      onClick={() => setJob(i)}
                      className={chip(job === i)}
                    >
                      {j}
                    </button>
                  ))}
                </div>
              </fieldset>
              <h2 className="mt-8 text-sm font-bold">Цены для {car.label}</h2>
              <ul className="mt-2 border-t-2 border-current">
                {B.jobs.map((j, i) => (
                  <li
                    key={j}
                    className={`flex items-baseline justify-between gap-4 border-b border-line py-2 ${job === i ? "font-bold text-accent-text" : ""}`}
                  >
                    <span>{j}</span>
                    <span className="tabular-nums">от {rub(car.prices[i] ?? 0)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
                <button type="submit" className={cta}>
                  {B.book.cta} от {rub(car.prices[job] ?? 0)}
                </button>
                <span className="text-sm">{B.book.slot}</span>
              </div>
            </form>
            <Trust className="mt-8" />
            <Credit photo={p} className="mt-4" />
          </div>
        </div>
      </section>
    </div>
  );
}

/** С5 «Опишите проблему»: one field for a quote, numbers of trust under it, then four steps and prices. */
export function ServiceAsk({ photos }: { photos: Photos }) {
  const p = photos["service-mechanic"];
  return (
    <div className="bg-background text-foreground">
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
      <section aria-labelledby="how" className="grid gap-10 px-gutter py-12 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h2 id="how" className="font-display text-2xl font-bold">
            Как это работает
          </h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-2">
            {B.ask.steps.map((s) => (
              <li key={s.n} className="border-t-4 border-accent pt-3">
                <span className="font-display text-3xl font-bold text-accent-text">{s.n}</span>
                <p className="mt-1 font-bold">{s.title}</p>
                <p className="text-sm text-muted-foreground">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="lg:col-span-4 lg:col-start-9">
          <h2 className="font-display text-2xl font-bold">Цены</h2>
          <ul className="mt-6 border-t-2 border-current">
            {B.ask.prices.map((x) => (
              <li key={x.job} className="flex items-baseline justify-between gap-4 border-b border-line py-2">
                <span>{x.job}</span>
                <span className="tabular-nums font-bold">от {rub(x.from)}</span>
              </li>
            ))}
          </ul>
          <Trust className="mt-6" />
          <Credit photo={p} className="mt-4" />
        </div>
      </section>
    </div>
  );
}

/** С6 «Госномер и акция»: the offer of the month with price and date, a plate field and job categories. */
export function ServicePlate({ photos }: { photos: Photos }) {
  const [cat, setCat] = useState(3);
  const p = photos["service-detail"];
  return (
    <div className="bg-background text-foreground">
      <Header />
      <section className="grid gap-0 lg:min-h-[calc(100svh-5.5rem)] lg:grid-cols-12">
        <div className="relative isolate flex min-h-[52svh] flex-col justify-end overflow-hidden px-gutter pb-8 text-scrim-foreground lg:col-span-7">
          <div className="absolute inset-0 -z-10">
            <div className="size-full bar-drift">
              <Img photo={p} />
            </div>
            <div className="absolute inset-0 bg-linear-to-t from-scrim via-scrim/70 to-scrim/10" />
          </div>
          <p className="text-sm font-bold uppercase tracking-widest">{B.promo.kicker}</p>
          <h1
            className={`${big} mt-3 text-[calc(var(--ds-text-display)*1.05)] lg:text-[calc(var(--ds-text-display)*1.7)]`}
          >
            {B.promo.title}
          </h1>
          <p className="mt-3 text-lg">
            {B.promo.terms}, обычно <s className="tabular-nums">{rub(B.promo.old)}</s>
          </p>
          <a href="#need" className={`${cta} mt-6 self-start`}>
            {B.promo.cta}
          </a>
        </div>
        <form
          id="need"
          aria-label={B.need.title}
          onSubmit={(e) => e.preventDefault()}
          className="flex flex-col gap-6 bg-surface px-gutter py-8 lg:col-span-5 lg:px-10"
        >
          <h2 className="font-display text-3xl font-bold">{B.need.title}</h2>
          <label className="block text-sm font-bold">
            {B.need.plateLabel}
            <span className="mt-2 flex min-h-16 items-stretch overflow-hidden rounded-control border-2 border-foreground bg-background font-display text-3xl font-bold">
              <input
                defaultValue={B.need.plate}
                size={1}
                className={`w-0 min-w-0 flex-1 bg-transparent px-4 uppercase tracking-wider ${focus}`}
              />
              <span className="flex flex-col items-center justify-center border-l-2 border-foreground px-3 text-xl leading-none">
                {B.need.region}
                <span className="text-xs font-bold">RUS</span>
              </span>
            </span>
          </label>
          <fieldset className="border-0 p-0">
            <legend className="text-sm font-bold">Категория</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {B.need.categories.map((c, i) => (
                <button
                  key={c.label}
                  type="button"
                  aria-pressed={cat === i}
                  onClick={() => setCat(i)}
                  className={`${chip(cat === i)} flex min-h-14 flex-col items-start justify-center py-2 text-left`}
                >
                  {c.label}
                  <span className="text-xs font-normal tabular-nums">
                    {c.from === 0 ? "0 ₽ по акции" : `от ${rub(c.from)}`}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <button type="submit" className={cta}>
            {B.need.cta}
          </button>
          <Trust className="mt-auto" />
          <Credit photo={p} />
        </form>
      </section>
    </div>
  );
}
