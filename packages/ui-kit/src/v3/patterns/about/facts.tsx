// About «facts»: a quiet tinted band — the title and lead, then a row of two to four facts of the brief between heavy
// rules, each value set large over what it means (only confirmed facts, catalog K03, D49), and the story in two
// columns below. Own composition.
type Link = { label: string; href: string };

export type AboutFactsProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  facts: { value: string; label: string }[];
  action?: Link;
};

const COLS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" };
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutFacts({ title, lead, paragraphs, facts, action }: AboutFactsProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-5 text-lead text-pretty">{lead}</p> : null}
        </div>
        <dl
          className={`mt-12 grid grid-cols-2 gap-x-6 border-y-2 border-foreground ${COLS[facts.length] ?? "lg:grid-cols-4"}`}
        >
          {facts.map((f) => (
            <div
              key={f.label}
              className="flex min-w-0 flex-col-reverse justify-end gap-2 py-6 lg:border-l lg:border-border lg:py-8 lg:pl-8 lg:first:border-l-0 lg:first:pl-0"
            >
              <dt className="text-small text-pretty text-muted-foreground">{f.label}</dt>
              <dd className="font-display text-h1 font-bold wrap-break-word tabular-nums lg:text-hero">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-12 grid gap-6 text-body text-pretty md:grid-cols-2 md:gap-12">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        {action ? (
          <a href={action.href} className={`mt-8 ${linkClass}`}>
            <span>{action.label}</span>
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
