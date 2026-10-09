// Testimonials «rating source»: the platform's own rating set large with what it counts, the date it was copied and
// a link to check it, next to one to three reviews from the same place (catalog D1 Proof «rating-link»: a number only
// with its source and date, 38-ФЗ). Own composition.
type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsRatingSourceProps = {
  title: string;
  lead?: string;
  summary: { value: string; label: string; count?: string; date: string; source: Link };
  reviews: Review[];
};

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsRatingSource({
  title,
  lead,
  summary,
  reviews,
}: TestimonialsRatingSourceProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        </div>
        <div className="mt-10 grid gap-10 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="flex min-w-0 flex-col rounded-lg bg-muted p-6 sm:p-10 lg:col-span-5">
            <p className="font-display text-hero leading-none font-bold tabular-nums">{summary.value}</p>
            <p className="mt-4 text-lead font-bold text-balance">{summary.label}</p>
            {summary.count ? <p className="mt-1 text-body text-muted-foreground">{summary.count}</p> : null}
            <p className="mt-1 text-small text-muted-foreground">{summary.date}</p>
            <a
              href={summary.source.href}
              className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 self-start rounded-control border border-foreground px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:mt-auto"
            >
              {summary.source.label}
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <ul className="flex min-w-0 flex-col gap-8 lg:col-span-7">
            {reviews.map((r) => (
              <li
                key={`${r.author}|${r.text.slice(0, 40)}`}
                className="border-l-2 border-primary pl-5 sm:pl-8"
              >
                <figure>
                  <blockquote>
                    <p className="text-lead text-pretty wrap-break-word">{r.text}</p>
                  </blockquote>
                  <figcaption className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-bold wrap-break-word">{r.author}</span>
                    {r.rating ? (
                      <span className="text-small text-muted-foreground">
                        Оценка {score(r.rating.value)} из {r.rating.max}
                      </span>
                    ) : null}
                    {r.date ? <span className="text-small text-muted-foreground">{r.date}</span> : null}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
