// Gallery «masonry»: photos of alternating tall, wide and square crops flow into two columns (three from lg) like
// laid stones; CSS columns keep every photo with its caption whole, so no holes appear whatever the count
// (catalog D1 Gallery «masonry»). Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryMasonryProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

/** Crops in turn: the rhythm of the stones (whole class names, so the build finds them). */
const CROPS = ["aspect-3/4", "aspect-4/3", "aspect-square", "aspect-4/5", "aspect-3/2"] as const;

export default function GalleryMasonry({ title, lead, images, action }: GalleryMasonryProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 max-w-3xl">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
          </div>
          {action ? (
            <a
              href={action.href}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control border border-foreground px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
          ) : null}
        </div>
        <ul className="mt-10 columns-2 gap-3 sm:gap-4 lg:mt-14 lg:columns-3 lg:gap-6">
          {images.map((im, i) => (
            <li key={im.src} className="mb-3 break-inside-avoid sm:mb-4 lg:mb-6">
              <figure>
                <img
                  src={im.src}
                  alt={im.alt}
                  loading="lazy"
                  className={`w-full rounded-md bg-muted object-cover ${CROPS[i % CROPS.length]}`}
                />
                {im.caption ? (
                  <figcaption className="mt-2 text-small text-muted-foreground">{im.caption}</figcaption>
                ) : null}
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
