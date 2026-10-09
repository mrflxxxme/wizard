// Contacts «columns»: a quiet band between rules with the four answers side by side — where, how to call, when and
// how to write — divided by vertical hairlines on wide screens and stacked under short labels on phones. Fits the
// bottom of a page right before the footer. Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsColumnsProps = {
  title: string;
  lead?: string;
  address: { text: string; note?: string };
  map: string;
  phones: Phone[];
  messengers?: Link[];
  email?: string;
  hours: Hours[];
};

const labelClass = "text-small font-bold text-muted-foreground";
const colClass =
  "min-w-0 border-t border-border pt-5 lg:border-t-0 lg:pt-0 lg:px-8 lg:first:pl-0 lg:last:pr-0";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsColumns({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
}: ContactsColumnsProps) {
  const write = Boolean(messengers?.length || email);
  return (
    <section className="border-y border-border bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-3 max-w-text text-body text-muted-foreground">{lead}</p> : null}
        <div
          className={`mt-10 grid gap-6 sm:grid-cols-2 lg:gap-y-0 lg:divide-x lg:divide-border ${write ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}
        >
          <div className={colClass}>
            <h3 className={labelClass}>Адрес</h3>
            <p className="mt-2 text-body font-bold text-balance wrap-break-word">{address.text}</p>
            {address.note ? <p className="mt-1 text-small text-muted-foreground">{address.note}</p> : null}
            <a href={map} className={`gap-2 text-small underline ${linkClass}`}>
              Открыть в Яндекс Картах
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className={colClass}>
            <h3 className={labelClass}>Телефон</h3>
            <ul className="mt-1">
              {phones.map((p) => (
                <li key={p.href}>
                  <a href={p.href} className={`text-lead whitespace-nowrap tabular-nums ${linkClass}`}>
                    {p.number}
                  </a>
                  {p.note ? <p className="-mt-2 text-small text-muted-foreground">{p.note}</p> : null}
                </li>
              ))}
            </ul>
          </div>
          <div className={colClass}>
            <h3 className={labelClass}>Часы работы</h3>
            <ul className="mt-2 flex flex-col gap-1 text-body">
              {hours.map((h) => (
                <li key={h.days}>
                  {h.days} <span className="font-bold whitespace-nowrap tabular-nums">{h.time}</span>
                </li>
              ))}
            </ul>
          </div>
          {write ? (
            <div className={colClass}>
              <h3 className={labelClass}>Написать</h3>
              <ul className="mt-1 flex flex-col">
                {messengers?.map((m) => (
                  <li key={m.href}>
                    <a href={m.href} className={`text-body underline ${linkClass}`}>
                      {m.label}
                    </a>
                  </li>
                ))}
                {email ? (
                  <li>
                    <a href={`mailto:${email}`} className={`text-body break-all underline ${linkClass}`}>
                      {email}
                    </a>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
