// Testimonials «photo quote»: the client's photo of the work or the place across the section, one review on a scrim
// panel at the lower left, so the text holds over any part of the photo (catalog I04). The photo is never a face
// standing in for the author (I02). Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};
type Image = { src: string; alt: string };

export type TestimonialsPhotoQuoteProps = {
  title: string;
  quote: Review;
  image: Image;
};

export default function TestimonialsPhotoQuote({ title, quote, image }: TestimonialsPhotoQuoteProps) {
  return (
    <section className="relative isolate overflow-hidden bg-inverse font-sans">
      <img
        src={image.src}
        srcSet={srcSetOf(image.src)}
        sizes="(min-width: 1024px) 50vw, 100vw"
        alt={image.alt}
        loading="lazy"
        className="absolute inset-0 -z-10 h-full w-full object-cover"
      />
      <div className="mx-auto flex min-h-[34rem] w-full max-w-page items-end px-gutter py-section lg:min-h-[40rem]">
        <figure className="w-full max-w-2xl rounded-lg bg-scrim p-6 text-scrim-foreground sm:p-10">
          <h2 className="text-small font-bold wrap-break-word text-scrim-foreground">{title}</h2>
          <blockquote className="mt-4">
            <p className="font-display text-h2 text-pretty wrap-break-word hyphens-auto">«{quote.text}»</p>
          </blockquote>
          <figcaption className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-scrim-foreground/40 pt-4 text-body">
            <span className="font-bold wrap-break-word">{quote.author}</span>
            {quote.detail ? <span>{quote.detail}</span> : null}
            {quote.source?.href ? (
              <a
                href={quote.source.href}
                className="inline-flex min-h-11 min-w-11 items-center text-small font-bold text-scrim-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground"
              >
                {quote.source.label}
              </a>
            ) : quote.source ? (
              <span className="text-small">{quote.source.label}</span>
            ) : null}
            {quote.date ? <span className="text-small">{quote.date}</span> : null}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
