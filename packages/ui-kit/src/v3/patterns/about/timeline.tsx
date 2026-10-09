// About «timeline»: the title, lead and story pinned on the left; on the right the history as a vertical line with
// a marker per milestone — the date large in the display face, what happened beside it. Dates only from the brief
// (D49). Own composition.
type Link = { label: string; href: string };

export type AboutTimelineProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  milestones: { when: string; text: string }[];
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutTimeline({ title, lead, paragraphs, milestones, action }: AboutTimelineProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-12 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:sticky lg:top-8 lg:col-span-5 lg:self-start">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-5 text-lead text-pretty">{lead}</p> : null}
          <div className="mt-5 grid gap-4 text-body text-pretty text-muted-foreground">
            {paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {action ? (
            <a href={action.href} className={`mt-6 ${linkClass}`}>
              <span>{action.label}</span>
              <span aria-hidden="true">→</span>
            </a>
          ) : null}
        </div>
        <ol className="min-w-0 border-l-2 border-foreground lg:col-span-6 lg:col-start-7 lg:self-start">
          {milestones.map((m) => (
            <li
              key={`${m.when} ${m.text}`}
              className="relative grid gap-1 pb-10 pl-8 last:pb-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-6 sm:pl-10"
            >
              <span
                aria-hidden="true"
                className="absolute top-3 -left-[9px] size-4 rounded-full border-2 border-foreground bg-background"
              />
              <p className="font-display text-h2 font-bold tabular-nums">{m.when}</p>
              <p className="text-lead text-pretty sm:pt-1">{m.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
