// Header (ui-kit.yaml#components.Header, M2-43): brand, menu and one action; on phones the menu folds behind «Меню»
// (disclosure button, Esc closes and returns focus).
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import type { HeaderProps } from "./types.js";

export function Header(props: HeaderProps): ReactNode {
  const root = useWzRoot("Header", "wz-header", props);
  const { brand, logo, links = [], cta, variant = "bar", sticky = false } = props;
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const navId = `wz-header-nav-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

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

  return (
    <header
      {...root}
      className={cx(
        s.header,
        sticky && s.sticky,
        variant === "centered" && s.headerCentered,
        props.className,
      )}
    >
      <div className={s.headerInner}>
        <a className={s.brand} href="/" data-testid="wz-header-brand">
          {logo && (logo.fileId || logo.src) && (
            <span className={s.logo}>
              <ImageImpl
                root={part("wz-header-logo")}
                {...logo}
                alt={logo.alt || brand}
                ratio="1/1"
                fit="contain"
                priority
                rounded={false}
              />
            </span>
          )}
          <span>{brand}</span>
        </a>
        {links.length > 0 && (
          <button
            ref={toggle}
            type="button"
            className={s.menuToggle}
            aria-expanded={open}
            aria-controls={navId}
            data-testid="wz-header-menu"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? ru.blocks.closeMenu : ru.blocks.menu}
          </button>
        )}
        {links.length > 0 && (
          <nav
            id={navId}
            aria-label={ru.blocks.nav}
            className={cx(s.nav, open && s.navOpen)}
            data-testid="wz-header-nav"
          >
            <ul className={s.navList}>
              {links.map((l) => (
                <li key={`${l.href}:${l.label}`}>
                  <a className={s.navLink} href={l.href} onClick={() => setOpen(false)}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {cta && (
          <a className={cx(s.btn, s.headerCta)} href={cta.href} data-testid="wz-header-cta">
            {cta.label}
          </a>
        )}
      </div>
    </header>
  );
}
