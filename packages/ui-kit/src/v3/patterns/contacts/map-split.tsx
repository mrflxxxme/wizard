// Contacts «map split»: a static map or a photo of the entrance on one half, the whole of it a link to the place on
// Яндекс Картах (no embedded widget: the page loads no third-party scripts); on the other half the address, phones,
// hours and messengers as a list of terms between rules (catalog D1 Contacts «map-split»). Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsMapSplitProps = {
  title: string;
  lead?: string;
  address: { text: string; note?: string };
  map: string;
  phones: Phone[];
  messengers?: Link[];
  email?: string;
  hours: Hours[];
  image: Image;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsMapSplit({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  email,
  hours,
  image,
}: ContactsMapSplitProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-6 lg:col-start-7 lg:row-start-1">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p> : null}
          <dl className="mt-8 divide-y divide-border border-y border-border">
            <div className="grid gap-1 py-5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-small font-bold text-muted-foreground">Адрес</dt>
              <dd className="min-w-0">
                <p className="text-lead font-bold text-balance wrap-break-word">{address.text}</p>
                {address.note ? <p className="mt-2 text-body text-muted-foreground">{address.note}</p> : null}
              </dd>
            </div>
            <div className="grid gap-1 py-5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-small font-bold text-muted-foreground">Телефон</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                {phones.map((p) => (
                  <p key={p.href} className="flex flex-col">
                    <a
                      href={p.href}
                      className={`self-start text-lead whitespace-nowrap tabular-nums ${linkClass}`}
                    >
                      {p.number}
                    </a>
                    {p.note ? <span className="-mt-1 text-small text-muted-foreground">{p.note}</span> : null}
                  </p>
                ))}
              </dd>
            </div>
            <div className="grid gap-1 py-5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-small font-bold text-muted-foreground">Часы работы</dt>
              <dd className="min-w-0">
                <ul className="flex flex-col gap-1 text-body">
                  {hours.map((h) => (
                    <li key={h.days} className="flex justify-between gap-4 sm:justify-start">
                      <span className="sm:w-36">{h.days}</span>
                      <span className="font-bold tabular-nums">{h.time}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            {messengers?.length || email ? (
              <div className="grid gap-1 py-5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
                <dt className="text-small font-bold text-muted-foreground">Написать</dt>
                <dd className="flex min-w-0 flex-wrap gap-x-6">
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
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="min-w-0 lg:col-span-6 lg:col-start-1 lg:row-start-1">
          <a
            href={map}
            className="group relative block overflow-hidden rounded-lg bg-muted text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:sticky lg:top-8"
          >
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              className="aspect-4/3 w-full object-cover lg:aspect-4/5"
            />
            <span className="absolute bottom-4 left-4 inline-flex min-h-11 items-center gap-2 rounded-control bg-card px-4 text-body font-bold text-card-foreground shadow-md transition-colors duration-200 group-hover:bg-background">
              Открыть в Яндекс Картах
              <span aria-hidden="true">↗</span>
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
