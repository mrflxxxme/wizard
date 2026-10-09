// Services «tabs»: the services as tabs — a column of rows with prices on desktop, a scrolling strip of pills on
// phones — and the panel of the chosen one with its photo, description, what is included, price and booking. Tabs
// follow the WAI-ARIA pattern: arrows, Home and End move between them, only the chosen tab is in the Tab order.
// Own composition.
import { type KeyboardEvent, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Service = {
  title: string;
  text?: string;
  price?: string;
  duration?: string;
  points?: string[];
  image?: Image;
  link?: Link;
};

export type ServicesTabsProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const tabClass =
  "group inline-flex min-h-11 shrink-0 items-center justify-between gap-6 rounded-control border border-border px-5 text-left text-body font-bold text-foreground transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:border-foreground aria-selected:bg-foreground aria-selected:text-background lg:w-full lg:rounded-none lg:border-0 lg:border-b lg:border-border lg:px-0 lg:py-5 lg:font-display lg:text-h3 lg:text-muted-foreground lg:hover:text-foreground lg:aria-selected:border-border lg:aria-selected:bg-transparent lg:aria-selected:text-foreground";

/** Index of the tab a key moves to, or -1 for keys the tab list does not handle. */
function moveTo(key: string, i: number, n: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowLeft" || key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return -1;
}

export default function ServicesTabs({ title, intro, items, action, note }: ServicesTabsProps) {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = moveTo(e.key, i, items.length);
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div className="mt-10 grid gap-8 lg:mt-14 lg:grid-cols-12 lg:gap-12">
          <div
            role="tablist"
            aria-label={title}
            className="-mx-gutter flex min-w-0 gap-2 overflow-x-auto px-gutter pb-2 lg:col-span-4 lg:mx-0 lg:flex-col lg:gap-0 lg:self-start lg:overflow-visible lg:border-t-2 lg:border-foreground lg:px-0 lg:pb-0"
          >
            {items.map((s, i) => (
              <button
                key={s.title}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${i}`}
                aria-selected={i === active}
                aria-controls={`${id}-panel-${i}`}
                tabIndex={i === active ? 0 : -1}
                onClick={() => setActive(i)}
                onKeyDown={(e) => onKey(e, i)}
                className={tabClass}
              >
                <span className="min-w-0 wrap-break-word">{s.title}</span>
                {s.price ? (
                  <span className="hidden font-sans text-body whitespace-nowrap tabular-nums lg:inline">
                    {s.price}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="min-w-0 lg:col-span-8">
            {items.map((s, i) => {
              const cta = s.link ?? action;
              return (
                <div
                  key={s.title}
                  role="tabpanel"
                  id={`${id}-panel-${i}`}
                  aria-labelledby={`${id}-tab-${i}`}
                  hidden={i !== active}
                >
                  {s.image ? (
                    <img
                      src={s.image.src}
                      alt={s.image.alt}
                      loading="lazy"
                      className="aspect-16/10 w-full rounded-lg bg-muted object-cover"
                    />
                  ) : null}
                  <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10">
                    <div className="min-w-0">
                      <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">
                        {s.title}
                      </h3>
                      {s.text ? (
                        <p className="mt-3 text-lead text-pretty text-muted-foreground">{s.text}</p>
                      ) : null}
                      {s.points?.length ? (
                        <ul className="mt-5 grid gap-2 border-t border-border pt-5">
                          {s.points.map((p) => (
                            <li key={p} className="flex gap-3 text-body">
                              <span
                                aria-hidden="true"
                                className="mt-[0.8em] h-px w-4 shrink-0 bg-foreground"
                              />
                              <span className="min-w-0">{p}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-col items-start gap-4 md:max-w-xs md:border-l md:border-border md:pl-8">
                      {s.price ? (
                        <p className="font-display text-h1 font-bold whitespace-nowrap tabular-nums">
                          {s.price}
                        </p>
                      ) : null}
                      {s.duration ? <p className="text-body text-muted-foreground">{s.duration}</p> : null}
                      {cta ? (
                        <a href={cta.href} className={primaryClass}>
                          {cta.label}
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {note ? <p className="mt-8 text-small text-muted-foreground">{note}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
