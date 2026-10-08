// Footer «centered»: brand and tagline on the axis, the links of all columns in one wrapping row, social links, the
// legal lines centred at the bottom. Composition after HyperUI «Footers» (MIT, © Mark Mead), rewritten on the design
// system tokens.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type FooterCenteredProps = {
  brand: { name: string; href?: string; logo?: Image };
  tagline?: string;
  columns: { title: string; links: Link[] }[];
  social?: Link[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FooterCentered({ brand, tagline, columns, social, legal }: FooterCenteredProps) {
  const links = columns.flatMap((c) => c.links);
  return (
    <footer className="bg-muted font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-16 text-center">
        <a
          href={brand.href ?? "/"}
          className="inline-flex min-h-11 min-w-11 items-center gap-3 font-display text-h2 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-10 w-auto" /> : null}
          <span className="min-w-0 wrap-break-word">{brand.name}</span>
        </a>
        {tagline ? <p className="mt-3 max-w-text text-body text-muted-foreground">{tagline}</p> : null}
        <nav aria-label="Разделы сайта" className="mt-8">
          <ul className="flex flex-wrap justify-center gap-x-8 gap-y-1">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={linkClass}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {social?.length ? (
          <ul className="mt-4 flex flex-wrap justify-center gap-x-6">
            {social.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={`font-bold ${linkClass}`}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-10 w-full border-t border-border pt-6">
          <p className="text-small text-muted-foreground">
            {legal.operator}
            {legal.details ? `, ${legal.details}` : null}
          </p>
          <ul className="mt-2 flex flex-wrap justify-center gap-x-6">
            {[legal.policy, ...(legal.links ?? [])].map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="inline-flex min-h-11 min-w-11 items-center text-small text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
