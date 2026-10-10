// Header «utility bar»: a thin bar of practical facts on top (address and hours, the phone as a link), the main row
// with brand, menu and action below — for services people call before they come. Below lg the menu folds behind
// «Меню»; the phone stays visible. Own composition.
import { fitWords } from "@wizard/ui-kit/v3/headless";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderUtilityBarProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
  phone?: Link;
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

/**
 * The brand by words (pilot 10.10.2026): below lg each word is one unit, wrapped only between words, and the design
 * CSS (data-fit-words) sizes the line so its longest word fits the container; a word too long even then is hyphenated,
 * never cut silently. From lg on it is set as before.
 */
function BrandName({ name }: { name: string }) {
  const fit = fitWords(name);
  return (
    <span
      data-fit-words={fit.chars}
      lang="ru"
      className="block wrap-normal hyphens-auto lg:wrap-break-word lg:hyphens-manual"
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

export default function HeaderUtilityBar({ brand, nav, action, phone, note }: HeaderUtilityBarProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  return (
    <LazyMotion features={domAnimation}>
      <header className="relative z-20 bg-background font-sans text-foreground">
        {note || phone ? (
          <div className="bg-muted text-muted-foreground">
            <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-x-6 px-gutter">
              {note ? <p className="hidden py-2 text-small sm:block">{note}</p> : null}
              {phone ? (
                <a
                  href={phone.href}
                  className="ml-auto inline-flex min-h-11 min-w-11 items-center text-small font-bold whitespace-nowrap text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {phone.label}
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="border-b border-border">
          <div className="mx-auto flex w-full max-w-page items-center gap-8 px-gutter py-3">
            <a
              href={brand.href ?? "/"}
              className="inline-flex min-h-11 min-w-0 items-center gap-3 font-display text-h3 font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:flex-1"
            >
              {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-9 w-auto" /> : null}
              <span className="min-w-0 max-lg:flex-1 max-lg:@container">
                <BrandName name={brand.name} />
              </span>
            </a>
            <nav aria-label="Основное меню" className="ml-auto hidden lg:block">
              <ul className="flex items-center gap-6">
                {nav.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className={navLinkClass}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
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
              className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-control border border-border px-4 text-body font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
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
              <ul className="mx-auto flex w-full max-w-page flex-col px-gutter py-2">
                {nav.map((l) => (
                  <li key={l.href} className="border-b border-border last:border-b-0">
                    <a href={l.href} onClick={menu.close} className={`w-full ${navLinkClass}`}>
                      {l.label}
                    </a>
                  </li>
                ))}
                {action ? (
                  <li className="py-3">
                    <a href={action.href} onClick={menu.close} className={`flex w-full ${primaryClass}`}>
                      {action.label}
                    </a>
                  </li>
                ) : null}
                {note ? <li className="pb-3 text-small text-muted-foreground">{note}</li> : null}
              </ul>
            </m.nav>
          ) : null}
        </AnimatePresence>
      </header>
    </LazyMotion>
  );
}
