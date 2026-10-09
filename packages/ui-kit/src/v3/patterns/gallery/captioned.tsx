// Gallery «captioned»: a portfolio told as a list — every work gets a large photo across eight columns and its
// caption set in the display face in a narrow column beside it, the entries divided by rules; on phones the caption
// follows the photo. For a handful of works that each need a word. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption: string };

export type GalleryCaptionedProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

export default function GalleryCaptioned({ title, lead, images, action }: GalleryCaptionedProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 flex flex-col gap-10 lg:mt-14 lg:gap-14">
          {images.map((im) => (
            <li key={im.src} className="border-t border-border pt-6 lg:pt-8">
              <figure className="grid gap-4 lg:grid-cols-12 lg:gap-8">
                <img
                  src={im.src}
                  srcSet={srcSetOf(im.src)}
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  alt={im.alt}
                  loading="lazy"
                  className="aspect-3/2 w-full rounded-md bg-muted object-cover lg:col-span-8"
                />
                <figcaption className="font-display text-h3 text-pretty wrap-break-word lg:col-span-4">
                  {im.caption}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
        {action ? (
          <a
            href={action.href}
            className="mt-12 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
          </a>
        ) : null}
      </div>
    </section>
  );
}
