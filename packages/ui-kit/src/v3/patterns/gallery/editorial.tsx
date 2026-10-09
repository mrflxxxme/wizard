// Gallery «editorial»: a magazine spread — the lead photo tall across seven columns, two more stacked beside it,
// the rest in rows of three below; a row that would end with holes widens its last photos instead (catalog L12), and
// phones get the lead photo across and the others in pairs. Own composition.
type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryEditorialProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

/** Grid cell and crop of the photo at `i` of `n` (whole class names, so the build finds them). */
function cell(i: number, n: number): { box: string; crop: string } {
  if (i === 0)
    return {
      box: "col-span-2 lg:col-span-7 lg:row-span-2",
      crop: "aspect-4/5 lg:aspect-auto lg:min-h-96 lg:flex-1",
    };
  if (i < 3) return { box: "lg:col-span-5", crop: "aspect-4/3" };
  const rest = n - 3;
  const k = i - 3;
  const tail = rest % 3;
  // Phones: pairs; an odd photo at the end takes the whole row.
  const phone = rest % 2 === 1 && k === rest - 1 ? "col-span-2" : "";
  if (tail === 1 && k === rest - 1)
    return { box: `${phone} lg:col-span-12`, crop: "aspect-4/3 lg:aspect-21/9" };
  if (tail === 2 && k >= rest - 2) return { box: `${phone} lg:col-span-6`, crop: "aspect-4/3 lg:aspect-3/2" };
  return { box: `${phone} lg:col-span-4`, crop: "aspect-square" };
}

export default function GalleryEditorial({ title, lead, images, action }: GalleryEditorialProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="border-t border-foreground pt-6">
          <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p> : null}
        </div>
        <ul className="mt-10 grid grid-cols-2 gap-x-3 gap-y-6 lg:mt-12 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-8">
          {images.map((im, i) => {
            const c = cell(i, images.length);
            return (
              <li key={im.src} className={`min-w-0 ${c.box}`}>
                <figure className="flex h-full flex-col">
                  <div className={`relative w-full overflow-hidden rounded-sm bg-muted ${c.crop}`}>
                    <img
                      src={im.src}
                      alt={im.alt}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  </div>
                  {im.caption ? (
                    <figcaption
                      className={`mt-3 text-small text-muted-foreground ${i === 0 ? "lg:max-w-text" : ""}`}
                    >
                      {im.caption}
                    </figcaption>
                  ) : null}
                </figure>
              </li>
            );
          })}
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
