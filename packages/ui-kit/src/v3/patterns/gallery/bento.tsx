// Gallery «bento»: three to six photos in a tight grid of cells of different size — the first one large, the others
// around it — with exactly as many cells as photos for each count, so no holes appear (catalog L12). Captions stay
// out of the cells (I05); alt carries what each photo shows. Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryBentoProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

/** Grid of the bento by photo count and the cell of each photo (whole class names, so the build finds them). */
const LAYOUTS: Record<number, { grid: string; cells: string[] }> = {
  3: { grid: "lg:grid-cols-3", cells: ["col-span-2 row-span-2", "", ""] },
  4: {
    grid: "lg:grid-cols-4",
    cells: ["col-span-2 row-span-2", "col-span-2", "", ""],
  },
  5: { grid: "lg:grid-cols-4", cells: ["col-span-2 row-span-2", "", "", "", ""] },
  6: {
    grid: "lg:grid-cols-4",
    cells: ["col-span-2 row-span-2", "", "", "", "", "col-span-2 lg:col-span-4"],
  },
};

export default function GalleryBento({ title, lead, images, action }: GalleryBentoProps) {
  const layout = LAYOUTS[images.length] ?? LAYOUTS[6];
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul
          className={`mt-10 grid auto-rows-[10rem] grid-cols-2 gap-2 sm:auto-rows-[14rem] lg:mt-14 lg:auto-rows-[15rem] lg:gap-3 ${layout?.grid ?? ""}`}
        >
          {images.slice(0, 6).map((im, i) => (
            <li
              key={im.src}
              className={`min-w-0 overflow-hidden rounded-md bg-muted ${layout?.cells[i] ?? ""}`}
            >
              <img src={im.src} alt={im.alt} loading="lazy" className="h-full w-full object-cover" />
            </li>
          ))}
        </ul>
        {action ? (
          <a
            href={action.href}
            className="mt-10 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
