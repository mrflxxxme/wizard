// Footer «legal in full»: brand, tagline and contacts on the left, on the right a definition list of what the law
// asks to show — the personal data operator, requisites, documents (catalog D1 Footer legal-full, R02); the site
// links in a row below. Own composition.
type Link = { label: string; href: string };

export type FooterLegalFullProps = {
  brand: { name: string; href?: string };
  tagline?: string;
  contacts?: { label: string; value: string; href?: string }[];
  columns?: { title: string; links: Link[] }[];
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const docLinkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";

export default function FooterLegalFull({ brand, tagline, contacts, columns, legal }: FooterLegalFullProps) {
  const links = (columns ?? []).flatMap((c) => c.links);
  return (
    <footer className="border-t border-border bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-5">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-11 items-center font-display text-h3 font-bold wrap-break-word text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {brand.name}
            </a>
            {tagline ? <p className="mt-3 text-body text-muted-foreground">{tagline}</p> : null}
            {contacts?.length ? (
              <ul className="mt-6">
                {contacts.map((c) => (
                  <li key={c.label} className="min-w-0 py-1 text-body wrap-break-word">
                    <span className="text-muted-foreground">{c.label}: </span>
                    {c.href ? (
                      <a href={c.href} className={`font-bold ${docLinkClass}`}>
                        {c.value}
                      </a>
                    ) : (
                      c.value
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <dl className="min-w-0 divide-y divide-border border-y border-border lg:col-span-7">
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-small font-bold text-muted-foreground">Оператор персональных данных</dt>
              <dd className="text-body wrap-break-word">{legal.operator}</dd>
            </div>
            {legal.details ? (
              <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
                <dt className="text-small font-bold text-muted-foreground">Реквизиты</dt>
                <dd className="text-body wrap-break-word">{legal.details}</dd>
              </div>
            ) : null}
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-small font-bold text-muted-foreground">Документы</dt>
              <dd className="flex flex-col items-start">
                {[legal.policy, ...(legal.links ?? [])].map((l) => (
                  <a key={l.href} href={l.href} className={docLinkClass}>
                    {l.label}
                  </a>
                ))}
              </dd>
            </div>
          </dl>
        </div>
        {links.length ? (
          <nav aria-label="Разделы сайта" className="mt-10">
            <ul className="flex flex-wrap gap-x-8">
              {links.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    className="inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
