// Contacts «centered»: everything on the centre axis like a signboard — the address set large in the display face,
// how to get there, the phones, the hours in one line, the messengers as quiet buttons and the map link as the one
// filled action. For small places with one address; a part the owner did not give (the address, the hours) is left
// out, the first phone then takes the large line. Own composition.
type Link = { label: string; href: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsCenteredProps = {
  title: string;
  lead?: string;
  address?: { text: string; note?: string };
  map?: string;
  phones?: Phone[];
  messengers?: Link[];
  email?: string;
  hours?: Hours[];
};

const outlineClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsCentered({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
}: ContactsCenteredProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-section text-center">
        <h2 className="text-body font-bold text-muted-foreground">{title}</h2>
        {address ? (
          <p className="mt-4 max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">
            {address.text}
          </p>
        ) : null}
        {address?.note ? (
          <p className="mt-4 max-w-text text-body text-muted-foreground">{address.note}</p>
        ) : lead ? (
          <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p>
        ) : null}
        {map ? (
          <a
            href={map}
            className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Открыть в Яндекс Картах
            <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        <div className={`w-full max-w-3xl ${address ? "mt-12 border-t border-border pt-10" : "mt-6"}`}>
          <ul className="flex flex-wrap justify-center gap-x-10 gap-y-3">
            {(phones ?? []).map((p) => (
              <li key={p.href} className="flex flex-col items-center">
                <a
                  href={p.href}
                  className="inline-flex min-h-11 items-center font-display text-h2 font-bold whitespace-nowrap text-foreground tabular-nums underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {p.number}
                </a>
                {p.note ? <span className="text-small text-muted-foreground">{p.note}</span> : null}
              </li>
            ))}
          </ul>
          {hours?.length ? (
            <p className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-1 text-body">
              {hours.map((h) => (
                <span key={h.days}>
                  {h.days} <span className="font-bold whitespace-nowrap tabular-nums">{h.time}</span>
                </span>
              ))}
            </p>
          ) : null}
          {messengers?.length || email ? (
            <ul className="mt-8 flex flex-wrap justify-center gap-3">
              {messengers?.map((m) => (
                <li key={m.href}>
                  <a href={m.href} className={outlineClass}>
                    {m.label}
                  </a>
                </li>
              ))}
              {email ? (
                <li>
                  <a href={`mailto:${email}`} className={`break-all ${outlineClass}`}>
                    {email}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
