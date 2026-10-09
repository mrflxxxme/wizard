// Contacts «inverse panel»: a contrasting panel set like a reference card — the title, the lead and the actions on
// the left, the facts on the right as «what — where» rows between hairlines. One deliberate dark (or light) band on
// the page (catalog C10). Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsInversePanelProps = {
  title: string;
  lead?: string;
  address: { text: string; note?: string };
  map: string;
  phones: Phone[];
  messengers?: Link[];
  email?: string;
  hours: Hours[];
  action?: Link;
};

const rowClass =
  "grid gap-1 border-t border-inverse-foreground/30 py-5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-inverse-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground";

export default function ContactsInversePanel({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
  action,
}: ContactsInversePanelProps) {
  return (
    <section className="bg-background font-sans">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="grid gap-10 rounded-lg bg-inverse p-6 text-inverse-foreground sm:p-10 lg:grid-cols-12 lg:gap-8 lg:p-14">
          <div className="flex min-w-0 flex-col lg:col-span-5">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 max-w-text text-body">{lead}</p> : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:mt-auto lg:pt-10">
              {action ? (
                <a
                  href={action.href}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
                >
                  {action.label}
                </a>
              ) : null}
              <a
                href={map}
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control border border-inverse-foreground px-6 text-center text-body font-bold text-inverse-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
              >
                Открыть в Яндекс Картах
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          <dl className="min-w-0 border-b border-inverse-foreground/30 lg:col-span-7">
            <div className={rowClass}>
              <dt className="text-small font-bold">Адрес</dt>
              <dd className="min-w-0">
                <p className="text-lead font-bold text-balance wrap-break-word">{address.text}</p>
                {address.note ? <p className="mt-2 text-body">{address.note}</p> : null}
              </dd>
            </div>
            <div className={rowClass}>
              <dt className="text-small font-bold">Телефон</dt>
              <dd className="flex min-w-0 flex-col">
                {phones.map((p) => (
                  <p key={p.href} className="flex flex-wrap items-baseline gap-x-3">
                    <a href={p.href} className={`text-lead whitespace-nowrap tabular-nums ${linkClass}`}>
                      {p.number}
                    </a>
                    {p.note ? <span className="text-small">{p.note}</span> : null}
                  </p>
                ))}
              </dd>
            </div>
            <div className={rowClass}>
              <dt className="text-small font-bold">Часы работы</dt>
              <dd className="min-w-0">
                {hours.map((h) => (
                  <p key={h.days} className="text-body">
                    {h.days}: <span className="font-bold tabular-nums">{h.time}</span>
                  </p>
                ))}
              </dd>
            </div>
            {messengers?.length || email ? (
              <div className={rowClass}>
                <dt className="text-small font-bold">Написать</dt>
                <dd className="flex min-w-0 flex-wrap gap-x-6">
                  {messengers?.map((m) => (
                    <a key={m.href} href={m.href} className={`text-body ${linkClass}`}>
                      {m.label}
                    </a>
                  ))}
                  {email ? (
                    <a href={`mailto:${email}`} className={`text-body break-all ${linkClass}`}>
                      {email}
                    </a>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>
    </section>
  );
}
