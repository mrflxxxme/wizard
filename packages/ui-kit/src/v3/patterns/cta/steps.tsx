// Call to action «steps»: the message and the action on the left, the real order of getting started as a numbered
// list between rules on the right (numbers only for a real order, catalog L05). Own composition.
type Link = { label: string; href: string };

export type CtaStepsProps = {
  title: string;
  text?: string;
  action: Link;
  note?: string;
  steps: string[];
};

export default function CtaSteps({ title, text, action, note, steps }: CtaStepsProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 lg:col-span-5">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {text ? <p className="mt-4 text-body text-muted-foreground">{text}</p> : null}
          <a
            href={action.href}
            className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
          </a>
          {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
        </div>
        <ol className="min-w-0 divide-y divide-border border-y border-border lg:col-span-6 lg:col-start-7">
          {steps.map((step, i) => (
            <li key={step} className="grid grid-cols-[3rem_minmax(0,1fr)] items-baseline gap-4 py-5">
              <span className="font-display text-h2 font-bold text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="text-lead">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
