// Footer «action on top»: the footer opens with a band of the brand colour carrying the tagline and the main action,
// then brand, columns and contacts, then legal lines — the last chance to act without a separate section.
// Own composition.
type Link = { label: string; href: string };

export type FooterCtaTopProps = {
  brand: { name: string; href?: string };
  tagline: string;
  action: Link;
  columns: { title: string; links: Link[] }[];
  contacts?: { label: string; value: string; href?: string }[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";

export default function FooterCtaTop({
  brand,
  tagline,
  action,
  columns,
  contacts,
  legal,
}: FooterCtaTopProps) {
  return (
    <footer className="bg-background font-sans text-foreground">
      <div className="bg-primary text-primary-foreground">
        <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-gutter py-10 md:flex-row md:items-center md:justify-between">
          <p className="max-w-2xl font-display text-h2 font-bold text-balance wrap-break-word">{tagline}</p>
          <a
            href={action.href}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-control bg-background px-6 text-center text-body font-bold text-foreground transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground"
          >
            {action.label}
          </a>
        </div>
      </div>
      <div className="mx-auto w-full max-w-page px-gutter py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-12">
          <a
            href={brand.href ?? "/"}
            className="inline-flex min-h-11 items-start font-display text-h3 font-bold wrap-break-word text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:col-span-2 lg:col-span-3"
          >
            {brand.name}
          </a>
          {columns.map((c) => (
            <div key={c.title} className="min-w-0 lg:col-span-2">
              <h2 className="text-small font-bold text-muted-foreground">{c.title}</h2>
              <ul className="mt-2">
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
          {contacts?.length ? (
            <div className="min-w-0 sm:col-span-2 lg:col-span-3">
              <h2 className="text-small font-bold text-muted-foreground">Контакты</h2>
              <ul className="mt-2">
                {contacts.map((c) => (
                  <li key={c.label} className="min-w-0 py-1 text-body wrap-break-word">
                    {c.href ? (
                      <a href={c.href} className={linkClass}>
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mt-12 flex flex-col gap-2 border-t border-border pt-6 md:flex-row md:items-center md:justify-between md:gap-8">
          <p className="text-small text-muted-foreground">
            {legal.operator}
            {legal.details ? `, ${legal.details}` : null}
          </p>
          <ul className="flex flex-wrap gap-x-6">
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
