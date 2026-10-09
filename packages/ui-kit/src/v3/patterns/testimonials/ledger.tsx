// Testimonials «ledger»: a register of reviews under a heavy rule — who, when and where in a narrow left column,
// the words in a wide right one, each row closed by a hairline; on phones the signature comes first, like a letter.
// Own composition.
type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsLedgerProps = {
  title: string;
  lead?: string;
  reviews: Review[];
  more?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsLedger({ title, lead, reviews, more }: TestimonialsLedgerProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 border-t-2 border-foreground lg:mt-14">
          {reviews.map((r) => (
            <li
              key={`${r.author}|${r.text.slice(0, 40)}`}
              className="grid gap-3 border-b border-border py-8 md:grid-cols-12 md:gap-8 lg:py-10"
            >
              <div className="flex min-w-0 flex-col gap-1 md:col-span-4 lg:col-span-3">
                <p className="text-lead font-bold wrap-break-word">{r.author}</p>
                {r.detail ? <p className="text-small text-muted-foreground">{r.detail}</p> : null}
                <p className="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
                  {r.source?.href ? (
                    <a href={r.source.href} className={linkClass}>
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
              </div>
              <blockquote className="min-w-0 md:col-span-8 lg:col-span-8 lg:col-start-5">
                <p className="text-lead text-pretty wrap-break-word">{r.text}</p>
              </blockquote>
            </li>
          ))}
        </ul>
        {more ? (
          <a href={more.href} className={`mt-6 gap-2 text-body ${linkClass}`}>
            {more.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
