// Footer «wordmark»: link columns and contacts in a row on top, the brand name set at poster size across the bottom
// as the link home, legal lines under it. Own composition.
type Link = { label: string; href: string };

export type FooterWordmarkProps = {
  brand: { name: string; href?: string };
  columns: { title: string; links: Link[] }[];
  contacts?: { label: string; value: string; href?: string }[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";

export default function FooterWordmark({ brand, columns, contacts, legal }: FooterWordmarkProps) {
  return (
    <footer className="overflow-hidden bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter pt-16 pb-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {columns.map((c) => (
            <div key={c.title} className="min-w-0">
              <h2 className="font-display text-h3 font-bold">{c.title}</h2>
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
          {contacts?.length ? (
            <address className="min-w-0 not-italic">
              <h2 className="font-display text-h3 font-bold">Контакты</h2>
              <ul className="mt-3">
                {contacts.map((c) => (
                  <li key={c.label} className="min-w-0 py-1 text-body wrap-break-word">
                    {c.href ? (
                      <a href={c.href} className={`font-bold ${linkClass}`}>
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )}
                  </li>
                ))}
              </ul>
            </address>
          ) : null}
        </div>
        <a
          href={brand.href ?? "/"}
          className="mt-16 block border-t-2 border-foreground pt-6 font-display text-hero font-bold text-balance wrap-break-word hyphens-auto text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {brand.name}
        </a>
        <div className="mt-8 flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-8">
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
