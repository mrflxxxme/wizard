// Header «floating»: an inset bar on a card surface with a border and rounded corners, detached from the page edges;
// on lg the menu sits in the middle and the actions on the right, below lg the menu opens as a card under the bar.
// Control styling after shadcn/ui (MIT, © 2023 shadcn), rewritten on the design system tokens.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderFloatingProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
  secondary?: Link;
};

const navLinkClass =
  "inline-flex min-h-11 min-w-11 items-center rounded-md px-3 whitespace-nowrap text-body text-card-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const primaryClass =
  "min-h-11 items-center justify-center rounded-control bg-primary px-5 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const ghostClass =
  "min-h-11 items-center justify-center rounded-control px-4 text-center text-body font-bold text-card-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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

export default function HeaderFloating({ brand, nav, action, secondary }: HeaderFloatingProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  return (
    <header className="relative z-20 bg-background px-gutter pt-4 pb-2 font-sans text-foreground">
      <div className="relative mx-auto w-full max-w-page">
        <div className="flex items-center gap-4 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-4 text-card-foreground shadow-sm">
          <a
            href={brand.href ?? "/"}
            className="inline-flex min-h-11 min-w-0 items-center gap-2.5 font-display text-h3 font-bold text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-8 w-auto" /> : null}
            <span className="min-w-0 wrap-break-word">{brand.name}</span>
          </a>
          <nav aria-label="Основное меню" className="mx-auto hidden lg:block">
            <ul className="flex items-center gap-1">
              {nav.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={navLinkClass}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1 lg:ml-0">
            {secondary ? (
              <a href={secondary.href} className={`hidden whitespace-nowrap lg:inline-flex ${ghostClass}`}>
                {secondary.label}
              </a>
            ) : null}
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
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-muted px-4 text-body font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
            >
              {menu.open ? "Закрыть" : "Меню"}
            </button>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {menu.open ? (
            <motion.nav
              id={menu.id}
              aria-label="Основное меню"
              initial={{ opacity: 0, y: shift }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, y: shift, transition: { duration: 0.15 } }}
              className="absolute inset-x-0 top-full mt-2 rounded-lg border border-border bg-card p-2 text-card-foreground shadow-sm lg:hidden"
            >
              <ul className="flex flex-col">
                {nav.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} onClick={menu.close} className={`w-full ${navLinkClass}`}>
                      {l.label}
                    </a>
                  </li>
                ))}
                {secondary ? (
                  <li>
                    <a href={secondary.href} onClick={menu.close} className={`flex w-full ${ghostClass}`}>
                      {secondary.label}
                    </a>
                  </li>
                ) : null}
                {action ? (
                  <li className="pt-2">
                    <a href={action.href} onClick={menu.close} className={`flex w-full ${primaryClass}`}>
                      {action.label}
                    </a>
                  </li>
                ) : null}
              </ul>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </div>
    </header>
  );
}
