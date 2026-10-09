// About «full bleed»: a photo of the place across the full width with the title and lead on a scrim panel at its
// lower left (readable over any part of the photo, catalog I04); below it the story in a wide column and, beside it,
// the facts of the brief as a short list. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutFullBleedProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  image: Image;
  facts?: { value: string; label: string }[];
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutFullBleed({
  title,
  lead,
  paragraphs,
  image,
  facts,
  action,
}: AboutFullBleedProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="relative isolate flex min-h-120 items-end overflow-hidden bg-inverse lg:min-h-152">
        <img
          src={image.src}
          alt={image.alt}
          loading="lazy"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
        <div className="mx-auto w-full max-w-page px-gutter py-10 lg:py-14">
          <div className="max-w-2xl rounded-lg bg-scrim p-6 text-scrim-foreground sm:p-10">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 text-lead text-pretty">{lead}</p> : null}
          </div>
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-page gap-12 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:col-span-7">
          <div className="grid gap-5 text-lead text-pretty">
            {paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {action ? (
            <a href={action.href} className={`mt-8 ${linkClass}`}>
              <span>{action.label}</span>
              <span aria-hidden="true">→</span>
            </a>
          ) : null}
        </div>
        {facts?.length ? (
          <dl className="min-w-0 divide-y divide-border border-y border-border lg:col-span-4 lg:col-start-9">
            {facts.map((f) => (
              <div key={f.label} className="flex flex-col gap-1 py-4">
                <dt className="order-2 min-w-0 text-body text-pretty text-muted-foreground">{f.label}</dt>
                <dd className="order-1 font-display text-h2 font-bold wrap-break-word tabular-nums">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}
