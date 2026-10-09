// Testimonials «two column»: the title, the lead and the platforms the reviews come from (set as wordmarks in text,
// no borrowed logos) hold the left column; the reviews run down the right one between rules, each signed with the
// author, source and date. Own composition.
type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsTwoColumnProps = {
  title: string;
  lead?: string;
  reviews: Review[];
  more?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsTwoColumn({ title, lead, reviews, more }: TestimonialsTwoColumnProps) {
  // Each platform once, in the order the reviews name them.
  const sources = [
    ...new Map(reviews.flatMap((r) => (r.source ? [[r.source.label, r.source] as const] : []))).values(),
  ];
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-12 px-gutter py-section lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-4">
          <div className="lg:sticky lg:top-8">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 text-body text-muted-foreground">{lead}</p> : null}
            {sources.length ? (
              <div className="mt-10">
                <h3 className="text-small font-bold text-muted-foreground">Где опубликованы</h3>
                <ul className="mt-3 border-t border-border">
                  {sources.map((s) => (
                    <li key={s.label} className="border-b border-border">
                      {s.href ? (
                        <a
                          href={s.href}
                          className="flex min-h-14 items-center justify-between gap-4 font-display text-h3 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span className="min-w-0 wrap-break-word">{s.label}</span>
                          <span aria-hidden="true" className="text-body">
                            ↗
                          </span>
                        </a>
                      ) : (
                        <p className="flex min-h-14 items-center font-display text-h3 font-bold">{s.label}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {more ? (
              <a href={more.href} className={`mt-6 gap-2 text-body ${linkClass}`}>
                {more.label}
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        </div>
        <ul className="min-w-0 divide-y divide-border border-y border-border lg:col-span-7 lg:col-start-6">
          {reviews.map((r) => (
            <li key={`${r.author}|${r.text.slice(0, 40)}`} className="py-8 first:pt-8 lg:py-10">
              <figure>
                <blockquote>
                  <p className="text-lead text-pretty wrap-break-word">{r.text}</p>
                </blockquote>
                <figcaption className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-bold wrap-break-word">
                    {r.author}
                    {r.detail ? (
                      <span className="font-normal text-muted-foreground">, {r.detail}</span>
                    ) : null}
                  </span>
                  {r.source ? (
                    <span className="text-small text-muted-foreground">{r.source.label}</span>
                  ) : null}
                  {r.date ? <span className="text-small text-muted-foreground">{r.date}</span> : null}
                  {r.rating ? (
                    <span className="text-small text-muted-foreground">
                      Оценка {score(r.rating.value)} из {r.rating.max}
                    </span>
                  ) : null}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
