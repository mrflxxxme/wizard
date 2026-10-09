// Contacts «big phone»: for businesses that live on calls — the main number set at poster size as the tel: link
// itself, other numbers under it; below a heavy rule the address, the hours and the ways to write in three columns.
// Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsBigPhoneProps = {
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
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsBigPhone({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
}: ContactsBigPhoneProps) {
  const [main, ...more] = phones;
  const write = Boolean(messengers?.length || email);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-3 max-w-text text-body text-muted-foreground">{lead}</p> : null}
        {main ? (
          <div className="mt-8 lg:mt-10">
            <a
              href={main.href}
              className="inline-flex min-h-11 items-center font-display text-h1 font-bold text-foreground tabular-nums decoration-primary decoration-4 underline-offset-8 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-hero"
            >
              {main.number}
            </a>
            {main.note ? <p className="mt-2 text-body text-muted-foreground">{main.note}</p> : null}
          </div>
        ) : null}
        {more.length ? (
          <ul className="mt-4 flex flex-wrap gap-x-10 gap-y-2">
            {more.map((p) => (
              <li key={p.href} className="flex flex-wrap items-baseline gap-x-3">
                <a href={p.href} className={`text-h3 whitespace-nowrap tabular-nums ${linkClass}`}>
                  {p.number}
                </a>
                {p.note ? <span className="text-small text-muted-foreground">{p.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div
          className={`mt-12 grid gap-8 border-t-2 border-foreground pt-8 md:grid-cols-2 lg:mt-16 ${write ? "lg:grid-cols-3" : ""}`}
        >
          <div className="min-w-0">
            <h3 className={labelClass}>Адрес</h3>
            <p className="mt-2 text-lead font-bold text-balance wrap-break-word">{address.text}</p>
            {address.note ? <p className="mt-2 text-body text-muted-foreground">{address.note}</p> : null}
            <a href={map} className={`mt-2 gap-2 text-body ${linkClass}`}>
              Открыть в Яндекс Картах
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="min-w-0">
            <h3 className={labelClass}>Часы работы</h3>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-body">
              {hours.map((h) => (
                <div key={h.days} className="contents">
                  <dt>{h.days}</dt>
                  <dd className="font-bold tabular-nums">{h.time}</dd>
                </div>
              ))}
            </dl>
          </div>
          {write ? (
            <div className="min-w-0">
              <h3 className={labelClass}>Написать</h3>
              <ul className="mt-1 flex flex-col">
                {messengers?.map((m) => (
                  <li key={m.href}>
                    <a href={m.href} className={`text-body ${linkClass}`}>
                      {m.label}
                    </a>
                  </li>
                ))}
                {email ? (
                  <li>
                    <a href={`mailto:${email}`} className={`text-body break-all ${linkClass}`}>
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
