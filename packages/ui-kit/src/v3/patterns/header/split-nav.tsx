// Header «split navigation»: the menu is split in two around a centred brand, the action closes the right half —
// a symmetric composition for places and studios. Below lg: brand and «Меню». Own composition.
import { fitWords } from "@wizard/ui-kit/v3/headless";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderSplitNavProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
};

const navLinkClass =
  "inline-flex min-h-11 min-w-11 items-center whitespace-nowrap text-body text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const outlineClass =
  "min-h-11 items-center justify-center rounded-control border border-foreground px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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

/**
 * The brand by words (pilot 10.10.2026): below lg each word is one unit, wrapped only between words, and the design
 * CSS (data-fit-words, in capitals) sizes the line so its longest word fits the container; a word too long even then
 * is hyphenated, never cut silently. The tracking is set here, in em of the fitted size. From lg on it is set as before.
 */
function BrandName({ name }: { name: string }) {
  const fit = fitWords(name);
  return (
    <span
      data-fit-words={fit.chars}
      data-fit-caps=""
      lang="ru"
      className="block tracking-wide wrap-normal hyphens-auto lg:wrap-break-word lg:hyphens-manual"
    >
      {fit.words.map((w) => (
        <Fragment key={w.at}>
          {w.at > 0 ? " " : null}
          <span className="max-lg:inline-block">{w.text}</span>
        </Fragment>
      ))}
    </span>
  );
}

export default function HeaderSplitNav({ brand, nav, action }: HeaderSplitNavProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  const half = Math.ceil(nav.length / 2);
  return (
    <LazyMotion features={domAnimation}>
      <header className="relative z-20 border-b border-border bg-background font-sans text-foreground">
        <div className="mx-auto flex w-full max-w-page items-center gap-6 px-gutter py-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <nav aria-label="Разделы" className="hidden lg:block">
            <ul className="flex items-center gap-7">
              {nav.slice(0, half).map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={navLinkClass}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <a
            href={brand.href ?? "/"}
            className="inline-flex min-h-11 min-w-0 items-center gap-3 font-display text-h3 font-bold text-foreground uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:flex-1 lg:justify-self-center"
          >
            {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-10 w-auto" /> : null}
            <span className="min-w-0 max-lg:flex-1 max-lg:@container">
              <BrandName name={brand.name} />
            </span>
          </a>
          <div className="ml-auto flex items-center gap-7 lg:ml-0 lg:justify-self-end">
            <nav aria-label="Ещё разделы" className="hidden lg:block">
              <ul className="flex items-center gap-7">
                {nav.slice(half).map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className={navLinkClass}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {action ? (
              <a href={action.href} className={`hidden whitespace-nowrap lg:inline-flex ${outlineClass}`}>
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
        <AnimatePresence initial={false}>
          {menu.open ? (
            <m.nav
              id={menu.id}
              aria-label="Основное меню"
              initial={{ opacity: 0, y: shift }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, y: shift, transition: { duration: 0.15 } }}
              className="absolute inset-x-0 top-full border-b border-border bg-background lg:hidden"
            >
              <ul className="mx-auto grid w-full max-w-page grid-cols-2 gap-x-6 px-gutter py-3">
                {nav.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} onClick={menu.close} className={navLinkClass}>
                      {l.label}
                    </a>
                  </li>
                ))}
                {action ? (
                  <li className="col-span-2 pt-3">
                    <a href={action.href} onClick={menu.close} className={`flex w-full ${outlineClass}`}>
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
