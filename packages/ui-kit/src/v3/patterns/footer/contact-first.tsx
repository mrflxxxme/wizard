// Footer «contact first»: the main contact (the phone) set large as a link, the other contacts as a labelled list,
// the site links compact on the right, legal lines below — for businesses people call. Own composition.
type Link = { label: string; href: string };

export type FooterContactFirstProps = {
  brand: { name: string; href?: string };
  contacts: { label: string; value: string; href?: string }[];
  columns?: { title: string; links: Link[] }[];
  action?: Link;
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-9";

export default function FooterContactFirst({
  brand,
  contacts,
  columns,
  action,
  legal,
}: FooterContactFirstProps) {
  const [main, ...rest] = contacts;
  const links = (columns ?? []).flatMap((c) => c.links);
  return (
    <footer className="border-t-2 border-foreground bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <h2 className="text-small font-bold text-muted-foreground">{main?.label}</h2>
            {main ? (
              main.href ? (
                <a
                  href={main.href}
                  className="mt-1 inline-flex min-h-11 max-w-full items-center font-display text-h1 font-bold wrap-break-word text-foreground underline-offset-8 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {main.value}
                </a>
              ) : (
                <p className="mt-1 font-display text-h1 font-bold wrap-break-word">{main.value}</p>
              )
            ) : null}
            {rest.length ? (
              <dl className="mt-8 grid gap-6 sm:grid-cols-2">
                {rest.map((c) => (
                  <div key={c.label} className="min-w-0">
                    <dt className="text-small text-muted-foreground">{c.label}</dt>
                    <dd className="mt-1 text-body wrap-break-word">
                      {c.href ? (
                        <a href={c.href} className={`font-bold ${linkClass}`}>
                          {c.value}
                        </a>
                      ) : (
                        c.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {action ? (
              <a
                href={action.href}
                className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            ) : null}
          </div>
          <div className="min-w-0 lg:col-span-4 lg:col-start-9">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-11 items-center font-display text-h3 font-bold wrap-break-word text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {brand.name}
            </a>
            {links.length ? (
              <ul className="mt-4 grid grid-cols-2 gap-x-6">
                {links.map((l) => (
                  <li key={l.href} className="min-w-0">
                    <a href={l.href} className={linkClass}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
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
