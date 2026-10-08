// Call to action «photo overlay»: a photo across the section with a centred scrim card holding the message, the
// action and a direct contact; the scrim keeps text readable over any part of the photo (catalog I04).
// Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type CtaPhotoOverlayProps = {
  title: string;
  text?: string;
  action: Link;
  contact?: Link;
  image: Image;
};

export default function CtaPhotoOverlay({ title, text, action, contact, image }: CtaPhotoOverlayProps) {
  return (
    <section className="relative isolate overflow-hidden bg-inverse font-sans">
      <img
        src={image.src}
        alt={image.alt}
        loading="lazy"
        className="absolute inset-0 -z-10 h-full w-full object-cover"
      />
      <div className="mx-auto flex w-full max-w-page justify-center px-gutter py-section">
        <div className="w-full max-w-xl rounded-lg bg-scrim p-6 text-center text-scrim-foreground sm:p-12">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {text ? <p className="mt-4 text-body text-scrim-foreground">{text}</p> : null}
          <div className="mt-8 flex flex-col items-center gap-3">
            <a
              href={action.href}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground sm:w-auto"
            >
              {action.label}
            </a>
            {contact ? (
              <a
                href={contact.href}
                className="inline-flex min-h-11 min-w-11 items-center text-body font-bold text-scrim-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground"
              >
                {contact.label}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
