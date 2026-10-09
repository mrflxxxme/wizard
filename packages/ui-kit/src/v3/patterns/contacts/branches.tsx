// Contacts «branches»: several places of one business as a register under a heavy rule — the name, the address with
// its map link, the hours and the phone of each on one row from lg, stacked on phones (catalog D1 Contacts). For
// chains, studios with two halls and pick-up points. Own composition.
type Phone = { number: string; href: string; note?: string };
type Branch = { name: string; address: string; phone?: Phone; hours: string; map: string };

export type ContactsBranchesProps = {
  title: string;
  lead?: string;
  branches: Branch[];
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsBranches({ title, lead, branches }: ContactsBranchesProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 border-t-2 border-foreground lg:mt-14">
          {branches.map((b) => (
            <li
              key={b.name}
              className="grid gap-3 border-b border-border py-6 lg:grid-cols-12 lg:items-baseline lg:gap-8 lg:py-8"
            >
              <h3 className="font-display text-h3 font-bold text-balance wrap-break-word lg:col-span-3">
                {b.name}
              </h3>
              <div className="min-w-0 lg:col-span-3">
                <p className="text-body wrap-break-word">{b.address}</p>
                <a href={b.map} className={`gap-2 text-small underline ${linkClass}`}>
                  Открыть в Яндекс Картах
                  <span aria-hidden="true">↗</span>
                </a>
              </div>
              <p className="text-body text-muted-foreground lg:col-span-3">{b.hours}</p>
              <div className="min-w-0 lg:col-span-3 lg:text-right">
                {b.phone ? (
                  <a href={b.phone.href} className={`text-body whitespace-nowrap tabular-nums ${linkClass}`}>
                    {b.phone.number}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
