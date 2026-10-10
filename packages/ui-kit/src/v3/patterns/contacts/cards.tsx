// Contacts «cards»: four cards of different widths on the 12-column grid — the address with the map link across
// seven, the phones on a tinted card across five, then the hours and the ways to write crosswise, so the block reads as
// a composed sheet rather than a row of equal tiles (catalog D1 Contacts «cards», L01); a card the owner gave nothing
// for (the address, the hours) is left out and the others share the row. Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsCardsProps = {
  title: string;
  lead?: string;
  address?: { text: string; note?: string };
  map?: string;
  phones?: Phone[];
  messengers?: Link[];
  email?: string;
  hours?: Hours[];
};

const cardClass = "flex min-w-0 flex-col rounded-lg border border-border p-6 sm:p-8";
const labelClass = "text-small font-bold text-muted-foreground";
const outlineClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control border border-foreground px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsCards({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
}: ContactsCardsProps) {
  const write = !!(messengers?.length || email);
  // Spans of the 12-column grid: the address wide, the phones beside it; a card alone in its row takes all of it.
  const span = (wide: boolean, alone: boolean) =>
    alone ? "lg:col-span-12" : wide ? "lg:col-span-7" : "lg:col-span-5";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div className="mt-10 grid gap-4 lg:mt-14 lg:grid-cols-12">
          {address ? (
            <div className={`bg-card text-card-foreground ${span(true, !phones?.length)} ${cardClass}`}>
              <h3 className={labelClass}>Адрес</h3>
              <p className="mt-3 font-display text-h2 font-bold text-balance wrap-break-word">
                {address.text}
              </p>
              {address.note ? <p className="mt-3 text-body text-muted-foreground">{address.note}</p> : null}
              {map ? (
                <div className="mt-auto pt-8">
                  <a href={map} className={outlineClass}>
                    Открыть в Яндекс Картах
                    <span aria-hidden="true">↗</span>
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}
          {phones?.length ? (
            <div className={`bg-muted ${span(false, !address)} ${cardClass}`}>
              <h3 className={labelClass}>Телефон</h3>
              <ul className="mt-3 flex flex-col gap-4">
                {phones.map((p) => (
                  <li key={p.href}>
                    <a
                      href={p.href}
                      className="inline-flex min-h-11 items-center font-display text-h2 font-bold whitespace-nowrap text-foreground tabular-nums underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {p.number}
                    </a>
                    {p.note ? <p className="text-small text-muted-foreground">{p.note}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {hours?.length ? (
            <div className={`bg-card text-card-foreground ${span(false, !write)} ${cardClass}`}>
              <h3 className={labelClass}>Часы работы</h3>
              <ul className="mt-3 divide-y divide-border">
                {hours.map((h) => (
                  <li key={h.days} className="flex items-baseline justify-between gap-4 py-3">
                    <span className="text-body">{h.days}</span>
                    <span className="text-body font-bold tabular-nums">{h.time}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {write ? (
            <div className={`bg-card text-card-foreground ${span(true, !hours?.length)} ${cardClass}`}>
              <h3 className={labelClass}>Написать</h3>
              {messengers?.length ? (
                <ul className="mt-4 flex flex-wrap gap-3">
                  {messengers.map((m) => (
                    <li key={m.href}>
                      <a href={m.href} className={outlineClass}>
                        {m.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {email ? (
                <a
                  href={`mailto:${email}`}
                  className="mt-4 inline-flex min-h-11 min-w-11 items-center self-start text-lead font-bold break-all text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {email}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
