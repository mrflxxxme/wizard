// A crowded first screen: a tall photo first, then the promise, the lead and the action — on a phone the action is
// below the fold (L13 by the browser checks).
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
        {image ? (
          <img src={image} alt={imageAlt ?? ""} className="aspect-[3/4] w-full rounded-3xl object-cover" />
        ) : null}
        <h1 className="mt-10 font-display text-display font-bold text-balance wrap-break-word">{title}</h1>
        <p className="mt-6 max-w-prose text-lead text-muted-foreground wrap-break-word">{lead}</p>
        <a
          href={action.href}
          className="mt-8 inline-flex items-center rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground"
        >
          {action.label}
        </a>
      </div>
    </section>
  );
}
