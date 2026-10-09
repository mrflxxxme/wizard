// Testimonials «wall»: reviews of different lengths flow into one, two or three columns (CSS columns keep each card
// whole, so short and long reviews sit without a ragged grid); every card is signed with the author, the source and
// the date as given (catalog D1 Proof «reviews-wall»). Own composition.
type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsWallProps = {
  title: string;
  lead?: string;
  reviews: Review[];
  more?: Link;
};

const sourceClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

/** Source, date and rating exactly as given; the source links to the original when it has a link. */
function Meta({ r }: { r: Review }) {
  if (!r.source && !r.date && !r.rating) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-4 text-small text-muted-foreground">
      {r.source?.href ? (
        <a href={r.source.href} className={sourceClass}>
          {r.source.label}
        </a>
      ) : r.source ? (
        <span className="font-bold">{r.source.label}</span>
      ) : null}
      {r.date ? <span>{r.date}</span> : null}
      {r.rating ? (
        <span>
          Оценка {score(r.rating.value)} из {r.rating.max}
        </span>
      ) : null}
    </p>
  );
}

export default function TestimonialsWall({ title, lead, reviews, more }: TestimonialsWallProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        </div>
        <ul className="mt-10 columns-1 gap-5 md:columns-2 lg:mt-14 lg:columns-3 lg:gap-6">
          {reviews.map((r, i) => (
            <li key={`${r.author}|${r.text.slice(0, 40)}`} className="mb-5 break-inside-avoid lg:mb-6">
              <figure
                className={`flex flex-col gap-6 rounded-lg border border-border p-6 sm:p-8 ${i === 0 ? "bg-muted" : "bg-card text-card-foreground"}`}
              >
                <blockquote>
                  <p
                    className={
                      i === 0
                        ? "font-display text-h3 text-pretty wrap-break-word"
                        : "text-body text-pretty wrap-break-word"
                    }
                  >
                    {r.text}
                  </p>
                </blockquote>
                <figcaption className="flex flex-col gap-1 border-t border-border pt-4">
                  <span className="font-bold wrap-break-word">{r.author}</span>
                  {r.detail ? <span className="text-small text-muted-foreground">{r.detail}</span> : null}
                  <Meta r={r} />
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
        {more ? (
          <a
            href={more.href}
            className="mt-6 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {more.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
