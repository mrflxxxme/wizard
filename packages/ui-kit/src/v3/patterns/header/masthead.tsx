// Header «masthead»: an editorial nameplate — a line of practical facts with the action above, the brand set large
// in the display face across the page, the menu in a ruled row below. Below lg: a smaller nameplate and «Меню».
// Own composition.
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };

export type HeaderMastheadProps = {
  brand: { name: string; href?: string };
  nav: Link[];
  action?: Link;
  note?: string;
};

const navLinkClass =
  "inline-flex min-h-11 min-w-11 items-center whitespace-nowrap text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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

export default function HeaderMasthead({ brand, nav, action, note }: HeaderMastheadProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  return (
    <LazyMotion features={domAnimation}>
      <header className="relative z-20 bg-background font-sans text-foreground">
        <div className="mx-auto w-full max-w-page px-gutter">
          <div className="hidden items-center justify-between gap-6 border-b border-border lg:flex">
            <p className="py-2 text-small text-muted-foreground">{note}</p>
            {action ? (
              <a
                href={action.href}
                className="inline-flex min-h-11 min-w-11 items-center text-small font-bold whitespace-nowrap text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            ) : null}
          </div>
          <div className="flex items-end justify-between gap-4 py-4 lg:py-6">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-0 items-center font-display text-h2 font-bold wrap-break-word text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:text-hero"
            >
              {brand.name}
            </a>
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
          <nav aria-label="Основное меню" className="hidden border-y-2 border-foreground lg:block">
            <ul className="flex flex-wrap items-center divide-x divide-border">
              {nav.map((l) => (
                <li key={l.href} className="px-5 first:pl-0">
                  <a href={l.href} className={navLinkClass}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <AnimatePresence initial={false}>
          {menu.open ? (
            <m.nav
              id={menu.id}
              aria-label="Основное меню"
              initial={{ opacity: 0, y: shift }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, y: shift, transition: { duration: 0.15 } }}
              className="absolute inset-x-0 top-full border-y-2 border-foreground bg-background lg:hidden"
            >
              <ul className="mx-auto flex w-full max-w-page flex-col px-gutter py-2">
                {nav.map((l) => (
                  <li key={l.href} className="border-b border-border last:border-b-0">
                    <a href={l.href} onClick={menu.close} className={`w-full ${navLinkClass}`}>
                      {l.label}
                    </a>
                  </li>
                ))}
                {action ? (
                  <li className="py-2">
                    <a
                      href={action.href}
                      onClick={menu.close}
                      className={`w-full font-bold underline ${navLinkClass}`}
                    >
                      {action.label}
                    </a>
                  </li>
                ) : null}
              </ul>
            </m.nav>
          ) : null}
        </AnimatePresence>
      </header>
    </LazyMotion>
  );
}
