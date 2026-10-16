// Browser entry of the bar preview: renders the two sites from window.__BAR__ (photos as copies, the oven clock) and,
// in the shared preview, a switch between them that keeps the choice in the URL hash.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import BakerySite from "./bakery/site.js";
import type { PhotoSlot } from "./photos.js";
import ServiceSite from "./service/site.js";
import type { Photo } from "./still.js";

type Site = "bakery" | "service";
type BarData = { photos: Record<PhotoSlot, Photo>; sites: Site[]; now?: string; switcher: boolean };

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
if (root) createRoot(root).render(<Preview data={data} />);
