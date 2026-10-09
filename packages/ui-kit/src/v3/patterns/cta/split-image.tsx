// Call to action «split with photo»: one framed block, a photo filling one half and the message with actions in the
// other; on phones the photo sits on top. Composition after HyperUI «CTA» (MIT, © Mark Mead), rewritten on the
// design system tokens.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type CtaSplitImageProps = {
  title: string;
  text?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  image: Image;
};

export default function CtaSplitImage({ title, text, action, secondary, note, image }: CtaSplitImageProps) {
  return (
    <section className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="grid overflow-hidden rounded-lg border border-border bg-card text-card-foreground md:grid-cols-2">
          <img
            src={image.src}
            srcSet={srcSetOf(image.src)}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={image.alt}
            loading="lazy"
            className="aspect-4/3 h-full w-full bg-muted object-cover md:aspect-auto"
          />
          <div className="flex min-w-0 flex-col justify-center p-6 sm:p-10 lg:p-14">
            <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
            {text ? <p className="mt-4 text-body text-muted-foreground">{text}</p> : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <a
                href={action.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
              {secondary ? (
                <a
                  href={secondary.href}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-6 text-center text-body font-bold text-card-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {secondary.label}
                </a>
              ) : null}
            </div>
            {note ? <p className="mt-5 text-small text-muted-foreground">{note}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
