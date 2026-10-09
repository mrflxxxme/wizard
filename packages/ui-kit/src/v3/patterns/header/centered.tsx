// Header «centered»: the brand in the middle of the top row (a practical note on the left, the action on the right),
// the navigation centred in its own row under a rule. Below lg: brand and «Меню». Composition after HyperUI «Headers»
// (MIT, © Mark Mead), rewritten on the design system tokens.
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderCenteredProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
  note?: string;
};

const navLinkClass =
  "inline-flex min-h-11 min-w-11 items-center whitespace-nowrap text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const primaryClass =
  "min-h-11 items-center justify-center rounded-control bg-primary px-5 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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

export default function HeaderCentered({ brand, nav, action, note }: HeaderCenteredProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  return (
    <LazyMotion features={domAnimation}>
      <header className="relative z-20 bg-background font-sans text-foreground">
        <div className="mx-auto grid w-full max-w-page grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-gutter py-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <p className="hidden text-small text-muted-foreground lg:block">{note}</p>
          <a
            href={brand.href ?? "/"}
            className="inline-flex min-h-11 min-w-0 items-center gap-3 font-display text-h2 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:justify-self-center"
          >
            {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-10 w-auto" /> : null}
            <span className="min-w-0 wrap-break-word">{brand.name}</span>
          </a>
          <div className="flex items-center justify-self-end gap-3">
            {action ? (
              <a href={action.href} className={`hidden whitespace-nowrap lg:inline-flex ${primaryClass}`}>
                {action.label}
              </a>
            ) : null}
            <button
              ref={menu.toggle}
              type="button"
              aria-expanded={menu.open}
              aria-controls={menu.id}
              onClick={menu.flip}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-control border border-border px-4 text-body font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
            >
              {menu.open ? "Закрыть" : "Меню"}
            </button>
          </div>
        </div>
        <nav aria-label="Основное меню" className="hidden border-y border-border lg:block">
          <ul className="mx-auto flex w-full max-w-page items-center justify-center gap-10 px-gutter">
            {nav.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={navLinkClass}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <AnimatePresence initial={false}>
          {menu.open ? (
            <m.nav
              id={menu.id}
              aria-label="Основное меню"
              initial={{ opacity: 0, y: shift }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, y: shift, transition: { duration: 0.15 } }}
              className="absolute inset-x-0 top-full border-y border-border bg-background lg:hidden"
            >
              <ul className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-3 text-center">
                {nav.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} onClick={menu.close} className={navLinkClass}>
                      {l.label}
                    </a>
                  </li>
                ))}
                {action ? (
                  <li className="w-full pt-3">
                    <a href={action.href} onClick={menu.close} className={`flex w-full ${primaryClass}`}>
                      {action.label}
                    </a>
                  </li>
                ) : null}
                {note ? <li className="pt-3 text-small text-muted-foreground">{note}</li> : null}
              </ul>
            </m.nav>
          ) : null}
        </AnimatePresence>
      </header>
    </LazyMotion>
  );
}
