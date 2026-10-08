// Footer «panels»: two cards on a tinted field — contacts with brand and social links in one, the link columns in the
// other — and the legal line under them. Own composition.
type Link = { label: string; href: string };

export type FooterPanelsProps = {
  brand: { name: string; href?: string };
  tagline?: string;
  contacts: { label: string; value: string; href?: string }[];
  columns: { title: string; links: Link[] }[];
  social?: Link[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-card-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";

export default function FooterPanels({
  brand,
  tagline,
  contacts,
  columns,
  social,
  legal,
}: FooterPanelsProps) {
  return (
    <footer className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-12">
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="min-w-0 rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-8 lg:col-span-5">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-11 items-center font-display text-h3 font-bold wrap-break-word text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {brand.name}
            </a>
            {tagline ? <p className="mt-2 text-body text-muted-foreground">{tagline}</p> : null}
            <dl className="mt-6 grid gap-4">
              {contacts.map((c) => (
                <div key={c.label} className="min-w-0">
                  <dt className="text-small text-muted-foreground">{c.label}</dt>
                  <dd className="text-body font-bold wrap-break-word">
                    {c.href ? (
                      <a href={c.href} className={linkClass}>
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {social?.length ? (
              <ul className="mt-6 flex flex-wrap gap-x-6 border-t border-border pt-4">
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
          <div className="grid min-w-0 gap-8 rounded-lg border border-border bg-card p-6 text-card-foreground sm:grid-cols-2 sm:p-8 lg:col-span-7 lg:grid-cols-3">
            {columns.map((c) => (
              <div key={c.title} className="min-w-0">
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
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-8">
          <p className="text-small text-muted-foreground">
            {legal.operator}
            {legal.details ? `, ${legal.details}` : null}
          </p>
          <ul className="flex flex-wrap gap-x-6">
            {[legal.policy, ...(legal.links ?? [])].map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="inline-flex min-h-11 min-w-11 items-center text-small text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
