// The first screen as the page-by-sections composer wrote it in rehearsal №5: the promise, the lead, one action and the
// photo under them, on a light background.
export type HomeHeroProps = {
  title: string;
  lead: string;
  action: { label: string; href: string };
  image?: string;
  imageAlt?: string;
};

export default function HomeHero({ title, lead, action, image, imageAlt }: HomeHeroProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h1 className="font-display text-display font-bold text-balance wrap-break-word">{title}</h1>
        <p className="mt-6 max-w-prose text-lead text-muted-foreground wrap-break-word">{lead}</p>
        <a
          href={action.href}
          className="mt-8 inline-flex items-center rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground"
        >
          {action.label}
        </a>
        {image ? (
          <img src={image} alt={imageAlt ?? ""} className="mt-10 aspect-[4/3] w-full rounded-3xl object-cover" />
        ) : null}
      </div>
    </section>
  );
}
