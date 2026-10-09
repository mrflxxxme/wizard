// Gallery «split»: the title, the lead and the action hold the left third and stay in view on wide screens, while
// the photos run in two columns on the right, the second set lower than the first for a staggered rhythm.
// Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GallerySplitProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

function Column({ photos, crop }: { photos: Photo[]; crop: string }) {
  return (
    <ul className="flex min-w-0 flex-col gap-4 lg:gap-6">
      {photos.map((im) => (
        <li key={im.src}>
          <figure>
            <img
              src={im.src}
              alt={im.alt}
              loading="lazy"
              className={`w-full rounded-md bg-muted object-cover ${crop}`}
            />
            {im.caption ? (
              <figcaption className="mt-2 text-small text-muted-foreground">{im.caption}</figcaption>
            ) : null}
          </figure>
        </li>
      ))}
    </ul>
  );
}

export default function GallerySplit({ title, lead, images, action }: GallerySplitProps) {
  const left = images.filter((_, i) => i % 2 === 0);
  const right = images.filter((_, i) => i % 2 === 1);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-4">
          <div className="lg:sticky lg:top-8">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 text-body text-muted-foreground">{lead}</p> : null}
            {action ? (
              <a
                href={action.href}
                className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            ) : null}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 items-start gap-3 sm:gap-4 lg:col-span-8 lg:gap-6">
          <Column photos={left} crop="aspect-4/5" />
          <div className="pt-12 lg:pt-24">
            <Column photos={right} crop="aspect-square" />
          </div>
        </div>
      </div>
    </section>
  );
}
