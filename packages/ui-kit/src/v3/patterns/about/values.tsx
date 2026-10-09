// About «values»: how the work is done — the title and lead, then two to four principles as columns of a page
// separated by vertical rules (no icon cards, catalog L01, L02); each principle names the practice and says what it
// gives the customer. Own composition.
type Link = { label: string; href: string };

export type AboutValuesProps = {
  title: string;
  lead?: string;
  values: { title: string; text: string }[];
  action?: Link;
};

const COLS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" };
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutValues({ title, lead, values, action }: AboutValuesProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-5 text-lead text-pretty text-muted-foreground">{lead}</p> : null}
        </div>
        <ul
          className={`mt-14 grid gap-y-10 border-t-2 border-foreground pt-8 md:grid-cols-2 md:gap-x-10 lg:gap-x-0 ${COLS[values.length] ?? "lg:grid-cols-3"}`}
        >
          {values.map((v) => (
            <li
              key={v.title}
              className="min-w-0 lg:border-l lg:border-border lg:px-8 lg:first:border-l-0 lg:first:pl-0 lg:last:pr-0"
            >
              <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">{v.title}</h3>
              <p className="mt-4 text-body text-pretty text-muted-foreground">{v.text}</p>
            </li>
          ))}
        </ul>
        {action ? (
          <a href={action.href} className={`mt-12 ${linkClass}`}>
            <span>{action.label}</span>
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
