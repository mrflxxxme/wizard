// Browser entry of the bar preview: renders the two sites from window.__BAR__ (photos as copies, the oven clock) and,
// in the shared preview, a switch between them that keeps the choice in the URL hash. Grill-11 adds the heroes view:
// the chosen first screens П5 and С5 grown into full sites (round 4), switched the same way.
import { type ComponentType, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import BakerySite from "./bakery/site.js";
import { BakeryLoaf } from "./heroes/bakery.js";
import { ServiceAsk } from "./heroes/service.js";
import type { PhotoSlot } from "./photos.js";
import ServiceSite from "./service/site.js";
import type { Photo } from "./still.js";

type Site = "bakery" | "service";
type BarData = {
  photos: Record<PhotoSlot, Photo>;
  sites: Site[];
  now?: string;
  switcher: boolean;
  view?: "heroes";
};

type Hero = {
  id: string;
  site: Site;
  label: string;
  Screen: ComponentType<{ photos: Record<PhotoSlot, Photo> }>;
};
/** The two chosen screens of round 3 (grill-11, П5 and С5), grown into full sites in round 4. */
export const HEROES: Hero[] = [
  { id: "b5", site: "bakery", label: "П5 · Один хлеб", Screen: BakeryLoaf },
  { id: "s5", site: "service", label: "С5 · Опишите проблему", Screen: ServiceAsk },
];

function Heroes({ data }: { data: BarData }) {
  const fromHash = () => HEROES.find((h) => `#${h.id}` === location.hash) ?? (HEROES[0] as Hero);
  const [hero, setHero] = useState(fromHash);
  useEffect(() => {
    document.documentElement.dataset.site = hero.site;
  }, [hero]);
  const pick = (h: Hero) => {
    setHero(h);
    history.replaceState(null, "", `#${h.id}`);
    window.scrollTo(0, 0);
  };
  return (
    <>
      <div data-site={hero.site}>
        <hero.Screen photos={data.photos} />
      </div>
      {data.switcher ? (
        <div data-site="service" className="fixed inset-x-0 bottom-3 z-50 flex justify-center px-3">
          <fieldset className="m-0 flex max-w-full gap-1 overflow-x-auto rounded-control border border-border bg-card p-1 font-text shadow-md">
            <legend className="sr-only">Сайт</legend>
            {HEROES.map((h) => (
              <button
                key={h.id}
                type="button"
                aria-pressed={hero.id === h.id}
                onClick={() => pick(h)}
                className={`min-h-10 shrink-0 rounded-control px-3 text-sm font-bold whitespace-nowrap ${hero.id === h.id ? "bg-primary text-primary-foreground" : "text-foreground"}`}
              >
                {h.label}
              </button>
            ))}
          </fieldset>
        </div>
      ) : null}
    </>
  );
}

const SITES: Record<Site, string> = { bakery: "Мастерская: пекарня", service: "Ночной продукт: автосервис" };

function Preview({ data }: { data: BarData }) {
  const first = data.sites[0] ?? "bakery";
  const fromHash = (): Site =>
    location.hash === "#service" ? "service" : location.hash === "#bakery" ? "bakery" : first;
  const [site, setSite] = useState<Site>(data.switcher ? fromHash() : first);
  useEffect(() => {
    document.documentElement.dataset.site = site;
  }, [site]);
  const pick = (s: Site) => {
    setSite(s);
    history.replaceState(null, "", `#${s}`);
    window.scrollTo(0, 0);
  };
  return (
    <>
      <div data-site={site}>
        {site === "bakery" ? (
          <BakerySite photos={data.photos} {...(data.now ? { now: data.now } : {})} />
        ) : (
          <ServiceSite photos={data.photos} />
        )}
      </div>
      {data.switcher ? (
        <div data-site="service" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 bg-transparent">
          <fieldset className="m-0 flex gap-1 rounded-control border border-border bg-card p-1 font-text shadow-md">
            <legend className="sr-only">Сайт</legend>
            {data.sites.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={site === s}
                onClick={() => pick(s)}
                className={`min-h-10 rounded-control px-4 text-small font-bold whitespace-nowrap ${site === s ? "bg-primary text-primary-foreground" : "text-foreground"}`}
              >
                {SITES[s]}
              </button>
            ))}
          </fieldset>
        </div>
      ) : null}
    </>
  );
}

const data = (window as unknown as { __BAR__: BarData }).__BAR__;
const root = document.getElementById("bar-root");
if (root) createRoot(root).render(data.view === "heroes" ? <Heroes data={data} /> : <Preview data={data} />);
