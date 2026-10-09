// Gallery «full bleed»: the photos run from edge to edge of the screen — one wide frame, then a row of one to three
// set flush with hairline joints; the title above and the captions below stay on the page grid, each caption led by
// where its photo is. For places and interiors that need scale. Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryFullBleedProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

/** Columns of the lower row by its count (whole class names, so the build finds them). */
const ROW: Record<number, string> = { 1: "", 2: "grid-cols-2", 3: "grid-cols-3" };
/** Where each photo of the lower row is, for its caption. */
const PLACES: Record<number, string[]> = {
  1: ["Внизу"],
  2: ["Внизу слева", "Внизу справа"],
  3: ["Внизу слева", "Внизу в центре", "Внизу справа"],
};

export default function GalleryFullBleed({ title, lead, images, action }: GalleryFullBleedProps) {
  const [wide, ...row] = images;
  const places = ["Вверху", ...(PLACES[row.length] ?? [])];
  const captions = images.flatMap((im, i) =>
    im.caption ? [{ key: im.src, place: places[i], text: im.caption }] : [],
  );
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter pt-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
      </div>
      <div className="mt-10 flex flex-col gap-px bg-border lg:mt-14">
        {wide ? (
          <img
            src={wide.src}
            alt={wide.alt}
            loading="lazy"
            className="aspect-4/3 w-full bg-muted object-cover sm:aspect-16/9 lg:aspect-21/9"
          />
        ) : null}
        {row.length ? (
          <div className={`grid gap-px ${ROW[row.length] ?? "grid-cols-3"}`}>
            {row.map((im) => (
              <img
                key={im.src}
                src={im.src}
                alt={im.alt}
                loading="lazy"
                className="aspect-4/3 w-full bg-muted object-cover"
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className="mx-auto w-full max-w-page px-gutter pt-6 pb-section">
        {captions.length ? (
          <ul className="grid gap-x-8 gap-y-2 text-small text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
            {captions.map((c) => (
              <li key={c.key}>
                {c.place ? <span className="font-bold">{c.place}. </span> : null}
                {c.text}
              </li>
            ))}
          </ul>
        ) : null}
        {action ? (
          <a
            href={action.href}
            className="mt-8 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
