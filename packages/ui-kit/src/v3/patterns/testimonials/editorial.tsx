// Testimonials «editorial»: a magazine page between a heavy and a hairline rule — the main review set large in the
// display face across eight columns, two or three shorter ones in a narrow column behind a vertical rule.
// Own composition.
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsEditorialProps = {
  title: string;
  lead?: string;
  quote: Review;
  reviews: Review[];
};

const sourceClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** «Мария С., Яндекс Карты, сентябрь 2026»: the signature line; the source links to the original when it can. */
function Signature({ r, large = false }: { r: Review; large?: boolean }) {
  return (
    <figcaption
      className={`flex flex-wrap items-center gap-x-3 ${large ? "mt-8 text-body" : "mt-4 text-small"}`}
    >
      <span className="font-bold wrap-break-word">{r.author}</span>
      {r.detail ? <span className="text-muted-foreground">{r.detail}</span> : null}
      {r.source?.href ? (
        <a href={r.source.href} className={sourceClass}>
          {r.source.label}
        </a>
      ) : r.source ? (
        <span className="text-muted-foreground">{r.source.label}</span>
      ) : null}
      {r.date ? <span className="text-muted-foreground">{r.date}</span> : null}
    </figcaption>
  );
}

export default function TestimonialsEditorial({ title, lead, quote, reviews }: TestimonialsEditorialProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="border-t-4 border-foreground pt-6">
          <h2 className="max-w-3xl font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-3 max-w-text text-body text-muted-foreground">{lead}</p> : null}
        </div>
        <div className="mt-10 grid gap-12 border-b border-border pb-10 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <figure className="min-w-0 lg:col-span-8">
            <blockquote>
              <p className="font-display text-h1 text-pretty wrap-break-word hyphens-auto">
                <span aria-hidden="true" className="text-muted-foreground">
                  «
                </span>
                {quote.text}
                <span aria-hidden="true" className="text-muted-foreground">
                  »
                </span>
              </p>
            </blockquote>
            <Signature r={quote} large />
          </figure>
          <ul className="flex min-w-0 flex-col gap-8 border-t border-border pt-8 lg:col-span-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
            {reviews.map((r) => (
              <li key={`${r.author}|${r.text.slice(0, 40)}`}>
                <figure>
                  <blockquote>
                    <p className="text-body text-pretty wrap-break-word">{r.text}</p>
                  </blockquote>
                  <Signature r={r} />
                </figure>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
