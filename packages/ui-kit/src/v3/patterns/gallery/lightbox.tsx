// Gallery «lightbox»: a tight contact sheet of square thumbnails; each opens the photo large in a modal <dialog>
// (the page behind is inert, so focus stays inside) with its caption, «previous» and «next» buttons and the arrow
// keys; the named close button, Esc or a click on the dark field close it and focus returns to the thumbnail
// (catalog D1 Gallery «lightbox», A02, A06). Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";
import { useRef, useState } from "react";

type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryLightboxProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

const controlClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-scrim-foreground/50 px-4 text-body font-bold text-scrim-foreground transition-colors duration-200 hover:bg-scrim-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground";

export default function GalleryLightbox({ title, lead, images, action }: GalleryLightboxProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [current, setCurrent] = useState(0);
  const n = images.length;
  const shown = images[current];
  const step = (d: number) => setCurrent((c) => (c + d + n) % n);
  const open = (i: number, from: HTMLButtonElement) => {
    opener.current = from;
    setCurrent(i);
    dialog.current?.showModal();
  };
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:mt-12 lg:grid-cols-4 lg:gap-2">
          {images.map((im, i) => (
            <li key={im.src}>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={(e) => open(i, e.currentTarget)}
                className="group block w-full overflow-hidden rounded-sm bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <img
                  src={im.src}
                  srcSet={srcSetOf(im.src)}
                  sizes="100vw"
                  alt={im.alt}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-opacity duration-200 group-hover:opacity-85"
                />
              </button>
            </li>
          ))}
        </ul>
        {action ? (
          <a
            href={action.href}
            className="mt-10 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
      <dialog
        ref={dialog}
        aria-label={title}
        onClose={() => opener.current?.focus()}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") step(-1);
          if (e.key === "ArrowRight") step(1);
        }}
        onClick={(e) => {
          // A click on the dark field around the photo closes, like Esc.
          if (e.target instanceof HTMLElement && e.target.hasAttribute("data-backdrop"))
            dialog.current?.close();
        }}
        className="m-0 h-dvh max-h-none w-full max-w-none border-0 bg-background p-0 font-sans backdrop:bg-scrim"
      >
        {shown ? (
          // Two layers of the scrim over the page colour: a deep, even field whatever lies under the dialog.
          <div data-backdrop className="h-full w-full bg-scrim">
            <div data-backdrop className="h-full w-full bg-scrim text-scrim-foreground">
              <div
                data-backdrop
                className="mx-auto flex h-full w-full max-w-page flex-col gap-4 px-gutter py-4 sm:py-6"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="text-body tabular-nums">
                    {current + 1} / {n}
                  </p>
                  <button type="button" onClick={() => dialog.current?.close()} className={controlClass}>
                    Закрыть
                  </button>
                </div>
                <figure
                  data-backdrop
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4"
                >
                  <img
                    src={shown.src}
                    srcSet={srcSetOf(shown.src)}
                    sizes="100vw"
                    alt={shown.alt}
                    className="min-h-0 max-w-full flex-1 rounded-sm object-contain"
                  />
                  {shown.caption ? (
                    <figcaption className="max-w-text text-center text-body">{shown.caption}</figcaption>
                  ) : null}
                </figure>
                <div className="flex items-center justify-center gap-4">
                  <button
                    type="button"
                    aria-label="Предыдущее фото"
                    onClick={() => step(-1)}
                    className={controlClass}
                  >
                    <span aria-hidden="true">←</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Следующее фото"
                    onClick={() => step(1)}
                    className={controlClass}
                  >
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
