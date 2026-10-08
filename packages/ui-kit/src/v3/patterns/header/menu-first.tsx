// Header «menu first»: the bar holds only the brand, the action and «Меню» at every width; the menu opens as a panel
// with large links set in the display face, in two columns on wide screens. For sites whose first screen should stay
// clean (studios, galleries). Own composition.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderMenuFirstProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
  note?: string;
};

function useMenu() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return { open, id, toggle, flip: () => setOpen((v) => !v), close: () => setOpen(false) };
}

export default function HeaderMenuFirst({ brand, nav, action, note }: HeaderMenuFirstProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -12;
  return (
    <header className="relative z-20 bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page items-center gap-3 px-gutter py-4">
        <a
          href={brand.href ?? "/"}
          className="mr-auto inline-flex min-h-11 min-w-0 items-center gap-3 font-display text-h3 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-9 w-auto" /> : null}
          <span className="min-w-0 wrap-break-word">{brand.name}</span>
        </a>
        {action ? (
          <a
            href={action.href}
            className="hidden min-h-11 items-center justify-center rounded-control bg-primary px-5 text-body font-bold whitespace-nowrap text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:inline-flex"
          >
            {action.label}
          </a>
        ) : null}
        <button
          ref={menu.toggle}
          type="button"
          aria-expanded={menu.open}
          aria-controls={menu.id}
          onClick={menu.flip}
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control border border-border px-4 text-body font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span aria-hidden="true" className="flex w-4 flex-col gap-1">
            <span className="h-0.5 w-full bg-current" />
            <span className="h-0.5 w-full bg-current" />
          </span>
          {menu.open ? "Закрыть" : "Меню"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {menu.open ? (
          <motion.nav
            id={menu.id}
            aria-label="Основное меню"
            initial={{ opacity: 0, y: shift }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, y: shift, transition: { duration: 0.2 } }}
            className="absolute inset-x-0 top-full border-y border-border bg-background"
          >
            <div className="mx-auto grid w-full max-w-page gap-8 px-gutter py-8 md:grid-cols-[2fr_1fr]">
              <ul className="grid gap-x-10 sm:grid-cols-2">
                {nav.map((l) => (
                  <li key={l.href} className="border-b border-border">
                    <a
                      href={l.href}
                      onClick={menu.close}
                      className="flex min-h-11 w-full items-center py-2 font-display text-h2 font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col items-start gap-4">
                {note ? <p className="text-body text-muted-foreground">{note}</p> : null}
                {action ? (
                  <a
                    href={action.href}
                    onClick={menu.close}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-5 text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {action.label}
                  </a>
                ) : null}
              </div>
            </div>
          </motion.nav>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
