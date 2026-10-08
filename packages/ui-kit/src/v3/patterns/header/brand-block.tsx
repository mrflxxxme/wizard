// Header «brand block»: the brand sits in a solid block of the brand colour flush with the left edge of the page, the
// menu and the action run in the bar to its right; the bar spans the full width. Below lg: the block and «Меню».
// Own composition.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeaderBrandBlockProps = {
  brand: { name: string; href?: string; logo?: Image };
  nav: Link[];
  action?: Link;
  phone?: Link;
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

export default function HeaderBrandBlock({ brand, nav, action, phone }: HeaderBrandBlockProps) {
  const menu = useMenu();
  const reduce = useReducedMotion();
  const shift = reduce ? 0 : -8;
  return (
    <header className="relative z-20 border-b border-border bg-background font-sans text-foreground">
      <div className="flex items-stretch">
        <a
          href={brand.href ?? "/"}
          className="flex min-h-16 max-w-[70%] min-w-0 items-center gap-3 bg-primary px-gutter py-3 font-display text-h3 font-bold text-primary-foreground focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary-foreground lg:max-w-none lg:min-w-64"
        >
          {brand.logo ? <img src={brand.logo.src} alt={brand.logo.alt} className="h-9 w-auto" /> : null}
          <span className="min-w-0 wrap-break-word">{brand.name}</span>
        </a>
        <div className="flex flex-1 items-center justify-end gap-8 px-gutter lg:justify-between">
          <nav aria-label="Основное меню" className="hidden lg:block">
            <ul className="flex items-center gap-7">
              {nav.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={navLinkClass}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="hidden items-center gap-6 lg:flex">
            {phone ? (
              <a href={phone.href} className={`font-bold ${navLinkClass}`}>
                {phone.label}
              </a>
            ) : null}
            {action ? (
              <a
                href={action.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border-2 border-primary px-5 text-body font-bold whitespace-nowrap text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            ) : null}
          </div>
          <button
            ref={menu.toggle}
            type="button"
            aria-expanded={menu.open}
            aria-controls={menu.id}
            onClick={menu.flip}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-4 text-body font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
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
            className="absolute inset-x-0 top-full border-b border-border bg-background lg:hidden"
          >
            <ul className="flex w-full flex-col px-gutter py-2">
              {nav.map((l) => (
                <li key={l.href} className="border-b border-border">
                  <a href={l.href} onClick={menu.close} className={`w-full ${navLinkClass}`}>
                    {l.label}
                  </a>
                </li>
              ))}
              {phone ? (
                <li className="border-b border-border">
                  <a href={phone.href} onClick={menu.close} className={`w-full font-bold ${navLinkClass}`}>
                    {phone.label}
                  </a>
                </li>
              ) : null}
              {action ? (
                <li className="py-3">
                  <a
                    href={action.href}
                    onClick={menu.close}
                    className="flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-5 text-body font-bold text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {action.label}
                  </a>
                </li>
              ) : null}
            </ul>
          </motion.nav>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
