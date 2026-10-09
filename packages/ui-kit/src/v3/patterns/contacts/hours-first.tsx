// Contacts «hours first»: for places people visit by the clock — under the title the schedule takes the wider right
// column as a large table under a heavy rule (days and times in the display face, tabular figures); the address,
// phones, messengers and the action sit in a narrower column on the left, after the schedule on phones.
// Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsHoursFirstProps = {
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

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsHoursFirst({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
  action,
}: ContactsHoursFirstProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div className="mt-10 grid gap-12 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="min-w-0 lg:col-span-7 lg:col-start-6">
            <h3 className="text-small font-bold text-muted-foreground">Часы работы</h3>
            <dl className="mt-3 border-t-2 border-foreground">
              {hours.map((h) => (
                <div
                  key={h.days}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 border-b border-border py-4"
                >
                  <dt className="font-display text-h3 font-bold">{h.days}</dt>
                  <dd className="font-display text-h3 tabular-nums">{h.time}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flex min-w-0 flex-col gap-8 lg:col-span-4 lg:col-start-1 lg:row-start-1">
            <div>
              <h3 className="text-small font-bold text-muted-foreground">Адрес</h3>
              <p className="mt-2 text-lead font-bold text-balance wrap-break-word">{address.text}</p>
              {address.note ? <p className="mt-2 text-body text-muted-foreground">{address.note}</p> : null}
              <a href={map} className={`gap-2 text-body underline ${linkClass}`}>
                Открыть в Яндекс Картах
                <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div>
              <h3 className="text-small font-bold text-muted-foreground">Телефон</h3>
              <ul className="mt-1">
                {phones.map((p) => (
                  <li key={p.href} className="flex flex-wrap items-baseline gap-x-3">
                    <a href={p.href} className={`text-lead whitespace-nowrap tabular-nums ${linkClass}`}>
                      {p.number}
                    </a>
                    {p.note ? <span className="text-small text-muted-foreground">{p.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            {messengers?.length || email ? (
              <div>
                <h3 className="text-small font-bold text-muted-foreground">Написать</h3>
                <p className="mt-1 flex flex-wrap gap-x-6">
                  {messengers?.map((m) => (
                    <a key={m.href} href={m.href} className={`text-body underline ${linkClass}`}>
                      {m.label}
                    </a>
                  ))}
                  {email ? (
                    <a href={`mailto:${email}`} className={`text-body break-all underline ${linkClass}`}>
                      {email}
                    </a>
                  ) : null}
                </p>
              </div>
            ) : null}
            {action ? (
              <a
                href={action.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center self-start rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:w-full"
              >
                {action.label}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
