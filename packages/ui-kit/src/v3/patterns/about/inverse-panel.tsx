// About «inverse panel»: a contrasting panel inset on the page — the story on the left with the action, on the right
// a column of facts of the brief between hairlines, each value large over its meaning. Own composition.
type Link = { label: string; href: string };

export type AboutInversePanelProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  facts: { value: string; label: string }[];
  action?: Link;
};

export default function AboutInversePanel({
  title,
  lead,
  paragraphs,
  facts,
  action,
}: AboutInversePanelProps) {
  return (
    <section className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="grid gap-10 rounded-lg bg-inverse p-6 text-inverse-foreground sm:p-10 lg:grid-cols-12 lg:gap-x-12 lg:p-16">
          <div className="min-w-0 lg:col-span-7">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-5 text-lead text-pretty">{lead}</p> : null}
            <div className="mt-5 grid gap-4 text-body text-pretty text-inverse-foreground/80">
              {paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            {action ? (
              <a
                href={action.href}
                className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-inverse-foreground px-6 text-center text-body font-bold text-inverse transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
              >
                {action.label}
              </a>
            ) : null}
          </div>
          <dl className="min-w-0 divide-y divide-inverse-foreground/20 border-y border-inverse-foreground/20 lg:col-span-4 lg:col-start-9 lg:self-end">
            {facts.map((f) => (
              <div key={f.label} className="flex flex-col py-5">
                <dt className="order-2 mt-1 text-small text-pretty text-inverse-foreground/80">{f.label}</dt>
                <dd className="order-1 font-display text-h1 font-bold wrap-break-word tabular-nums">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
