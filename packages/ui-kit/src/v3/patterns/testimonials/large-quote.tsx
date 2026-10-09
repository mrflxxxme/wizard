// Testimonials «large quote»: one review set in the display face at a large size, hung on a big guillemet in the
// margin; the author, the context and the source sit under a rule (catalog D1 Proof «quote-large»). Long reviews
// step down a size so a quote never fills the screen. Own composition.
type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsLargeQuoteProps = {
  title: string;
  quote: Review;
  more?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsLargeQuote({ title, quote, more }: TestimonialsLargeQuoteProps) {
  const long = quote.text.length > 220;
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="text-body font-bold text-muted-foreground wrap-break-word">{title}</h2>
        <figure className="mt-8 grid gap-x-8 lg:mt-12 lg:grid-cols-12">
          <span
            aria-hidden="true"
            className="-mb-4 font-display text-hero leading-none text-primary select-none lg:col-span-1 lg:mb-0 lg:text-right"
          >
            «
          </span>
          <blockquote className="min-w-0 lg:col-span-10">
            <p
              className={`font-display text-balance wrap-break-word hyphens-auto ${long ? "text-h2" : "text-h1"}`}
            >
              {quote.text}
            </p>
          </blockquote>
          <figcaption className="mt-10 flex min-w-0 flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-start sm:justify-between lg:col-span-10 lg:col-start-2">
            <div className="min-w-0">
              <p className="text-lead font-bold wrap-break-word">{quote.author}</p>
              {quote.detail ? <p className="mt-1 text-body text-muted-foreground">{quote.detail}</p> : null}
            </div>
            <div className="flex flex-col gap-1 text-small text-muted-foreground sm:items-end sm:text-right">
              {quote.source?.href ? (
                <a href={quote.source.href} className={linkClass}>
                  {quote.source.label}
                </a>
              ) : quote.source ? (
                <span className="font-bold">{quote.source.label}</span>
              ) : null}
              {quote.date ? <span>{quote.date}</span> : null}
              {quote.rating ? (
                <span>
                  Оценка {score(quote.rating.value)} из {quote.rating.max}
                </span>
              ) : null}
            </div>
          </figcaption>
        </figure>
        {more ? (
          <div className="mt-10 lg:grid lg:grid-cols-12 lg:gap-x-8">
            <a
              href={more.href}
              className={`gap-2 text-body lg:col-span-10 lg:col-start-2 lg:justify-self-start ${linkClass}`}
            >
              {more.label}
              <span aria-hidden="true">→</span>
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
