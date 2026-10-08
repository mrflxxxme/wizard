// Call to action «inverse panel»: a contrasting full-width panel, the message set at poster size on the left, on the
// right a short text, the action and a direct contact (phone or messenger) as a large link. Own composition.
type Link = { label: string; href: string };

export type CtaInversePanelProps = {
  title: string;
  text?: string;
  action: Link;
  contact?: Link;
};

export default function CtaInversePanel({ title, text, action, contact }: CtaInversePanelProps) {
  return (
    <section className="bg-inverse font-sans text-inverse-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:items-end lg:gap-12">
        <h2 className="min-w-0 font-display text-hero font-bold text-balance wrap-break-word hyphens-auto lg:col-span-8">
          {title}
        </h2>
        <div className="flex min-w-0 flex-col items-start gap-5 lg:col-span-4">
          {text ? <p className="text-lead">{text}</p> : null}
          <a
            href={action.href}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-control bg-inverse-foreground px-6 text-center text-body font-bold text-inverse transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground sm:w-auto"
          >
            {action.label}
          </a>
          {contact ? (
            <a
              href={contact.href}
              className="inline-flex min-h-11 min-w-11 items-center font-display text-h3 font-bold wrap-break-word text-inverse-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
            >
              {contact.label}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
