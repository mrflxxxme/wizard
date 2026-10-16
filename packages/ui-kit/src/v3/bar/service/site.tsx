// «Ночной продукт» bar site: a car service on one page (grill-11 (2)). Each section is its own component with typed
// props for the later cut into blocks; the signature moment is the car scheme with lit units and prices (CarScheme).
import { animate, domAnimation, LazyMotion, m, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BarFooter } from "../bakery/site.js";
import type { PhotoSlot } from "../photos.js";
import { type Photo, rub, useStill } from "../still.js";
import { SERVICE, type Unit } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
type Link = { label: string; href: string };

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const button = `inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-accent-strong ${focus}`;
const label = "font-display text-small font-bold uppercase tracking-widest";

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

export function ServiceFirst(p: {
  name: string;
  nav: readonly Link[];
  phone: string;
  phoneHref: string;
  title: string;
  lead: string;
  action: Link;
  slot: string;
  facts: readonly (readonly [string, string])[];
  photo: Photo;
}) {
  return (
    <section
      id="top"
      className="relative isolate flex min-h-[min(100svh,56rem)] flex-col bg-background text-scrim-foreground"
    >
      <img src={p.photo.src} alt={p.photo.alt} className="absolute inset-0 -z-10 size-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-scrim" />
      <header className="mx-auto flex w-full max-w-page items-center justify-between gap-6 px-gutter py-5">
        <a href="#top" className={`font-display text-lg font-bold tracking-wide uppercase ${focus}`}>
          {p.name}
        </a>
        <nav aria-label="Разделы" className="hidden gap-8 md:flex">
          {p.nav.map((l) => (
            <a key={l.href} href={l.href} className={`text-body underline-offset-4 hover:underline ${focus}`}>
              {l.label}
            </a>
          ))}
        </nav>
        <a href={p.phoneHref} className={`text-small font-bold whitespace-nowrap tabular-nums ${focus}`}>
          {p.phone}
        </a>
      </header>
      <div className="mx-auto mt-auto grid w-full max-w-page gap-10 px-gutter pt-24 pb-12 lg:grid-cols-12 lg:items-end lg:pb-16">
        <div className="lg:col-span-8">
          <h1 className="max-w-[16ch] font-display text-hero font-bold text-balance uppercase">{p.title}</h1>
          <p className="mt-6 max-w-text text-lead text-pretty">{p.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
            <a href={p.action.href} className={button}>
              {p.action.label}
            </a>
            <p className="flex items-center gap-2 text-body font-bold">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-ok" />
              {p.slot}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 border-t border-scrim-foreground/40 pt-5 lg:col-span-4 lg:grid-cols-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
          {p.facts.map(([v, t]) => (
            <div key={t}>
              <dt className="sr-only">{t}</dt>
              <dd className="font-display text-h3 font-bold tabular-nums">{v}</dd>
              <dd className="text-small">{t}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const BODY =
  "M60 238V192q2-26 36-33l152-19q52-55 112-68l160-2q56 2 96 60l104 20q32 8 34 40v48h-86a58 58 0 0 0-116 0H248a58 58 0 0 0-116 0Z";
const WINDOWS = ["M290 138q32-44 76-50l74-2v52Z", "M456 86h58q42 4 70 52H456Z"];

/**
 * Signature moment of the car service: a drawing of the car where each unit lights up with its prices. A scan line
 * passes once when the drawing comes into view and lights the units it crosses; then hover, focus or a tap picks a
 * unit. Still (390 px, reduced motion) — no scan, the prices of every unit are listed under the drawing.
 */
export function CarScheme(p: { title: string; titleStill: string; note: string; list: readonly Unit[] }) {
  const still = useStill();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.5 });
  const [scan, setScan] = useState(still ? 800 : 0);
  const [active, setActive] = useState(p.list[0]?.id ?? "");
  useEffect(() => {
    if (still) {
      setScan(800);
      return;
    }
    if (!seen) return;
    const c = animate(0, 800, { duration: 1.6, ease: [0.45, 0, 0.2, 1], onUpdate: setScan });
    return () => c.stop();
  }, [seen, still]);
  const unit = p.list.find((u) => u.id === active) ?? p.list[0];
  return (
    <LazyMotion features={domAnimation}>
      <section id="units" className="bg-background py-section text-foreground">
        <div className="mx-auto max-w-page px-gutter">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
            <h2 className="max-w-[22ch] font-display text-h1 font-bold text-balance">
              {still ? p.titleStill : p.title}
            </h2>
            <p className="max-w-text text-body text-muted-foreground">{p.note}</p>
          </div>
          <div className="mt-10 grid gap-10 lg:grid-cols-12">
            <div ref={ref} className="lg:col-span-8">
              <svg
                viewBox="0 0 800 320"
                role="img"
                aria-label="Схема автомобиля с узлами"
                className="w-full text-border"
              >
                <defs>
                  <pattern id="bar-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M20 0H0v20" fill="none" stroke="var(--ds-color-line)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width="800" height="320" fill="url(#bar-grid)" />
                <line x1="20" x2="780" y1="296" y2="296" stroke="currentColor" strokeDasharray="6 6" />
                <path d={BODY} fill="none" stroke="currentColor" strokeWidth="2" />
                {WINDOWS.map((d) => (
                  <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
                ))}
                {[190, 610].map((cx) => (
                  <g key={cx} fill="none" stroke="currentColor">
                    <circle cx={cx} cy="238" r="48" strokeWidth="2" />
                    <circle cx={cx} cy="238" r="22" strokeWidth="1.5" />
                  </g>
                ))}
                {scan > 0 && scan < 800 ? (
                  <line
                    x1={scan}
                    x2={scan}
                    y1="20"
                    y2="300"
                    stroke="var(--ds-color-accent)"
                    strokeWidth="2"
                  />
                ) : null}
                {p.list.map((u, i) => {
                  const lit = scan >= u.x;
                  const on = !still && u.id === unit?.id;
                  return (
                    <g key={u.id}>
                      {on ? <circle cx={u.x} cy={u.y} r="26" fill="var(--ds-color-accent-soft)" /> : null}
                      <circle
                        cx={u.x}
                        cy={u.y}
                        r="15"
                        fill={lit ? "var(--ds-color-accent)" : "var(--ds-color-surface)"}
                        stroke={lit ? "var(--ds-color-accent)" : "currentColor"}
                        strokeWidth="2"
                      />
                      <text
                        x={u.x}
                        y={u.y + 5}
                        textAnchor="middle"
                        fontSize="14"
                        fontWeight="700"
                        fill={lit ? "var(--ds-color-accent-ink)" : "var(--ds-color-ink)"}
                      >
                        {i + 1}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <fieldset className="mt-6 flex flex-wrap gap-2">
                <legend className="sr-only">Узлы</legend>
                {p.list.map((u, i) => (
                  <button
                    key={u.id}
                    type="button"
                    aria-pressed={!still && u.id === unit?.id}
                    onMouseEnter={() => setActive(u.id)}
                    onFocus={() => setActive(u.id)}
                    onClick={() => setActive(u.id)}
                    className={`min-h-11 rounded-control border px-4 text-small font-bold ${!still && u.id === unit?.id ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground"} ${focus}`}
                  >
                    {i + 1}. {u.name}
                  </button>
                ))}
              </fieldset>
            </div>
            {still ? (
              <div className="grid gap-8 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
                {p.list.map((u, i) => (
                  <JobTable key={u.id} unit={u} n={i + 1} />
                ))}
              </div>
            ) : unit ? (
              <m.div
                key={unit.id}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
                className="self-start rounded-md border border-primary bg-card p-6 lg:col-span-4"
                aria-live="polite"
              >
                <JobTable unit={unit} n={p.list.indexOf(unit) + 1} />
              </m.div>
            ) : null}
          </div>
        </div>
      </section>
    </LazyMotion>
  );
}

function JobTable({ unit, n }: { unit: Unit; n: number }) {
  return (
    <div>
      <p className={`${label} text-accent-text`}>Узел {n}</p>
      <h3 className="mt-1 font-display text-h3 font-bold">{unit.name}</h3>
      <table className="mt-4 w-full text-body">
        <tbody>
          {unit.jobs.map((j) => (
            <tr key={j.name} className="border-t border-line">
              <th scope="row" className="py-3 pr-3 text-left font-normal">
                {j.name}
                <span className="block text-small text-muted-foreground">{j.time}</span>
              </th>
              <td className="py-3 text-right font-bold whitespace-nowrap tabular-nums">{rub(j.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ServiceWork(p: {
  title: string;
  people: readonly { name: string; role: string; photo: Photo }[];
  photo: Photo;
}) {
  return (
    <section className="bg-muted py-section text-foreground">
      <div className="mx-auto grid max-w-page gap-6 px-gutter lg:grid-cols-12">
        <h2 className="font-display text-h1 font-bold lg:col-span-12">{p.title}</h2>
        <figure className="aspect-[3/2] overflow-hidden rounded-md lg:col-span-6 lg:row-span-2 lg:aspect-auto">
          <Img photo={p.photo} />
        </figure>
        {p.people.map((x) => (
          <figure key={x.name} className="grid grid-cols-5 gap-4 lg:col-span-6">
            <div className="col-span-2 aspect-square overflow-hidden rounded-md">
              <Img photo={x.photo} />
            </div>
            <figcaption className="col-span-3 self-end">
              <p className="font-display text-h3 font-bold">{x.name}</p>
              <p className="mt-2 text-body text-muted-foreground">{x.role}</p>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

export function ServiceBooking(p: {
  title: string;
  days: readonly string[];
  slots: readonly string[];
  taken: readonly (readonly string[])[];
  submit: string;
  done: (day: string, time: string) => string;
  units: readonly Unit[];
}) {
  const [day, setDay] = useState(0);
  const [time, setTime] = useState("");
  const [sent, setSent] = useState(false);
  const busy = new Set(p.taken[day] ?? []);
  const field = `mt-1 block min-h-12 w-full rounded-control border border-border bg-card px-4 text-body text-foreground ${focus}`;
  return (
    <section id="booking" className="bg-background py-section text-foreground">
      <form
        className="mx-auto grid max-w-page gap-10 px-gutter lg:grid-cols-12"
        onSubmit={(e) => {
          e.preventDefault();
          if (time) setSent(true);
        }}
      >
        <div className="lg:col-span-7">
          <h2 className="font-display text-h1 font-bold">{p.title}</h2>
          <fieldset className="mt-8">
            <legend className={label}>День</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {p.days.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={day === i}
                  onClick={() => {
                    setDay(i);
                    setTime("");
                  }}
                  className={`min-h-11 rounded-control border px-4 text-body ${day === i ? "border-primary bg-primary font-bold text-primary-foreground" : "border-border"} ${focus}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-8">
            <legend className={label}>Время</legend>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {p.slots.map((s) => {
                const off = busy.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={off}
                    aria-pressed={time === s}
                    aria-label={off ? `${s}, занято` : s}
                    onClick={() => setTime(s)}
                    className={`min-h-12 rounded-control border text-body font-bold tabular-nums ${off ? "border-line text-muted-foreground line-through" : time === s ? "border-primary bg-primary text-primary-foreground" : "border-border hover:border-primary"} ${focus}`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
        <div className="self-end rounded-md border border-line bg-card p-6 lg:col-span-5">
          <label className="block text-small font-bold">
            Работа
            <select name="job" className={field} defaultValue="">
              <option value="">Не знаю, нужна диагностика</option>
              {p.units.flatMap((u) =>
                u.jobs.map((j) => (
                  <option key={`${u.id}-${j.name}`} value={`${u.id}-${j.name}`}>
                    {j.name}, {rub(j.price)}
                  </option>
                )),
              )}
            </select>
          </label>
          <label className="mt-4 block text-small font-bold">
            Машина
            <input name="car" placeholder="Kia Rio 2017" className={field} />
          </label>
          <label className="mt-4 block text-small font-bold">
            Телефон
            <input name="phone" type="tel" autoComplete="tel" inputMode="tel" required className={field} />
          </label>
          <button type="submit" disabled={!time} className={`${button} mt-6 w-full disabled:opacity-60`}>
            {time ? `${p.submit} на ${time}` : "Выберите время"}
          </button>
          {sent ? (
            <p role="status" className="mt-4 text-body text-accent-text">
              {p.done(p.days[day] ?? "", time)}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

export function ServiceVisit(p: {
  title: string;
  address: string;
  addressNote: string;
  hours: string;
  phone: string;
  phoneHref: string;
  photo: Photo;
}) {
  return (
    <section id="visit" className="bg-muted py-section text-foreground">
      <div className="mx-auto grid max-w-page items-center gap-10 px-gutter lg:grid-cols-12">
        <div className="lg:col-span-6">
          <h2 className={`${label} text-accent-text`}>{p.title}</h2>
          <p className="mt-4 font-display text-h2 font-bold text-balance">{p.address}</p>
          <p className="mt-4 max-w-text text-body text-muted-foreground">{p.addressNote}</p>
          <p className="mt-6 text-lead font-bold">{p.hours}</p>
          <a
            href={p.phoneHref}
            className={`mt-2 inline-block text-lead font-bold text-accent-text tabular-nums ${focus}`}
          >
            {p.phone}
          </a>
        </div>
        <div className="aspect-[3/2] overflow-hidden rounded-md lg:col-span-6">
          <Img photo={p.photo} />
        </div>
      </div>
    </section>
  );
}

export default function ServiceSite({ photos }: { photos: Photos }) {
  const s = SERVICE;
  const used = [s.first.photo, s.work.photo, ...s.work.people.map((x) => x.photo), s.visit.photo] as const;
  return (
    <div className="bg-background font-text text-foreground">
      <main>
        <ServiceFirst
          {...s.first}
          name={s.name}
          nav={s.nav}
          phone={s.phone}
          phoneHref={s.phoneHref}
          photo={photos[s.first.photo]}
        />
        <CarScheme {...s.units} />
        <ServiceBooking {...s.booking} units={s.units.list} />
        <ServiceWork
          title={s.work.title}
          people={s.work.people.map((x) => ({ ...x, photo: photos[x.photo] }))}
          photo={photos[s.work.photo]}
        />
        <ServiceVisit
          {...s.visit}
          address={s.address}
          addressNote={s.addressNote}
          phone={s.phone}
          phoneHref={s.phoneHref}
          photo={photos[s.visit.photo]}
        />
      </main>
      <BarFooter legal={s.legal} credits={used.map((x) => photos[x])} />
    </div>
  );
}
