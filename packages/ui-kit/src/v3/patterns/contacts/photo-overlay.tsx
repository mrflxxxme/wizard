// Contacts «photo overlay»: the photo of the entrance or the facade across the section — what a visitor will look
// for on arrival — with an opaque card of the address, hours, phone and map link over its left part; on phones the
// card overlaps the bottom of the photo instead of covering it. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Phone = { number: string; href: string; note?: string };
type Hours = { days: string; time: string };

export type ContactsPhotoOverlayProps = {
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
  "inline-flex min-h-11 min-w-11 items-center font-bold text-card-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ContactsPhotoOverlay({
  title,
  lead,
  address,
  map,
  phones,
  messengers,
  hours,
  image,
}: ContactsPhotoOverlayProps) {
  return (
    <section className="relative isolate bg-background font-sans text-foreground lg:bg-inverse">
      <img
        src={image.src}
        alt={image.alt}
        loading="lazy"
        className="aspect-4/3 w-full object-cover sm:aspect-16/9 lg:absolute lg:inset-0 lg:-z-10 lg:aspect-auto lg:h-full"
      />
      <div className="mx-auto w-full max-w-page px-gutter pb-section lg:flex lg:min-h-[44rem] lg:items-center lg:py-section">
        <div className="relative -mt-16 w-full rounded-lg bg-card p-6 text-card-foreground shadow-md sm:p-10 lg:mt-0 lg:max-w-lg">
          <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-3 text-body text-muted-foreground">{lead}</p> : null}
          <p className="mt-6 text-lead font-bold text-balance wrap-break-word">{address.text}</p>
          {address.note ? <p className="mt-2 text-small text-muted-foreground">{address.note}</p> : null}
          <ul className="mt-6 flex flex-col gap-1 border-t border-border pt-5 text-body">
            {hours.map((h) => (
              <li key={h.days} className="flex justify-between gap-4">
                <span>{h.days}</span>
                <span className="font-bold tabular-nums">{h.time}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-col border-t border-border pt-3">
            {phones.map((p) => (
              <a
                key={p.href}
                href={p.href}
                className={`self-start text-lead whitespace-nowrap tabular-nums ${linkClass}`}
              >
                {p.number}
              </a>
            ))}
            {messengers?.length ? (
              <p className="flex flex-wrap gap-x-5">
                {messengers.map((m) => (
                  <a key={m.href} href={m.href} className={`text-body underline ${linkClass}`}>
                    {m.label}
                  </a>
                ))}
              </p>
            ) : null}
          </div>
          <a
            href={map}
            className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Открыть в Яндекс Картах
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  );
}
