// Gallery «grid»: an even grid of one crop, two columns from sm and three from lg, each photo with its caption
// under it (catalog D1 Gallery «grid»). The calm default when the photos are of one kind. Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryGridProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

export default function GalleryGrid({ title, lead, images, action }: GalleryGridProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 grid gap-x-5 gap-y-8 sm:grid-cols-2 lg:mt-14 lg:grid-cols-3 lg:gap-x-6 lg:gap-y-10">
          {images.map((im) => (
            <li key={im.src}>
              <figure>
                <img
                  src={im.src}
                  alt={im.alt}
                  loading="lazy"
                  className="aspect-4/3 w-full rounded-md bg-muted object-cover"
                />
                {im.caption ? (
                  <figcaption className="mt-3 text-small text-muted-foreground">{im.caption}</figcaption>
                ) : null}
              </figure>
            </li>
          ))}
        </ul>
        {action ? (
          <a
            href={action.href}
            className="mt-10 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
