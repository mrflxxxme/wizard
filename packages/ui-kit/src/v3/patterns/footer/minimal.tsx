// Footer «minimal»: one row — brand, the legal line and the policy link (stacked on phones); for one-page sites
// where the contacts live in their own section (catalog D1 Footer legal-min). Own composition.
type Link = { label: string; href: string };

export type FooterMinimalProps = {
  brand: { name: string; href?: string };
  legal: { operator: string; details?: string; policy: Link; links?: Link[] };
};

export default function FooterMinimal({ brand, legal }: FooterMinimalProps) {
  return (
    <footer className="border-t border-border bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col gap-3 px-gutter py-8 md:flex-row md:items-center md:gap-8">
        <a
          href={brand.href ?? "/"}
          className="inline-flex min-h-11 shrink-0 items-center font-display text-h3 font-bold wrap-break-word text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {brand.name}
        </a>
        <p className="min-w-0 text-small text-muted-foreground md:flex-1">
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
    </footer>
  );
}
