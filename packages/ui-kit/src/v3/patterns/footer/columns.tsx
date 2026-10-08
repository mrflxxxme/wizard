// Footer «columns»: brand, tagline and social links on the left, up to four columns of links on the right, the legal
// line (personal data operator, requisites, policy) under a rule. Composition after HyperUI «Footers» (MIT,
// © Mark Mead), rewritten on the design system tokens.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type FooterColumnsProps = {
  brand: { name: string; href?: string; logo?: Image };
  tagline?: string;
  columns: { title: string; links: Link[] }[];
  social?: Link[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";
const legalLinkClass =
  "inline-flex min-h-11 min-w-11 items-center text-small text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FooterColumns({ brand, tagline, columns, social, legal }: FooterColumnsProps) {
  return (
    <footer className="border-t border-border bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-4">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-11 items-center gap-3 font-display text-h3 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-9 w-auto" /> : null}
              <span className="min-w-0 wrap-break-word">{brand.name}</span>
            </a>
            {tagline ? <p className="mt-3 max-w-sm text-body text-muted-foreground">{tagline}</p> : null}
            {social?.length ? (
              <ul className="mt-6 flex flex-wrap gap-x-6">
                {social.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className={`font-bold ${linkClass}`}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-3 lg:col-span-8">
            {columns.map((c) => (
              <div key={c.title} className="min-w-0">
                <h2 className="text-small font-bold tracking-wide text-muted-foreground uppercase">
                  {c.title}
                </h2>
                <ul className="mt-3">
                  {c.links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} className={linkClass}>
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-12 flex flex-col gap-2 border-t border-border pt-6 md:flex-row md:items-center md:justify-between md:gap-8">
          <p className="text-small text-muted-foreground">
            {legal.operator}
            {legal.details ? `, ${legal.details}` : null}
          </p>
          <ul className="flex flex-wrap gap-x-6">
            {[legal.policy, ...(legal.links ?? [])].map((l) => (
              <li key={l.href}>
                <a href={l.href} className={legalLinkClass}>
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
