// Frame of the platform screens on the design system v2 (B2-33, prototype E): a floating glass top bar — the mark and
// «Born to Build», the screen title in serif when it is a «human» one (system name), the screen's actions, the cabinet
// navigation and the light/dark switch — over the page on the warm paper background.
import { Glass, Serif } from "@wizard/ui-kit/v2";
import type { ReactNode } from "react";
import { usePlatform } from "../../app/context.js";
import { navigate, useRoute } from "../../app/router.js";
import { isDark, useDarkScheme } from "../../app/theme.js";
import { shell } from "../../i18n/ru/shell.js";
import s from "./Shell.module.css";

/** In-app link: History API navigation, a real href for new tabs and screen readers. */
export function AppLink({
  to,
  className,
  children,
  testId,
  current,
  label,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  testId?: string;
  current?: boolean;
  label?: string;
}): ReactNode {
  return (
    <a
      href={to}
      className={className}
      data-testid={testId}
      aria-current={current ? "page" : undefined}
      aria-label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** The mark of Born to Build: two overlapping rounded squares. */
export function BrandMark({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={className ?? s.mark}>
      <rect className={s.m1} x="2" y="2" width="10" height="10" rx="3" />
      <rect className={s.m2} x="8" y="8" width="10" height="10" rx="3" />
    </svg>
  );
}

/** Light / dark switch (the choice is shared with the canvas screen). */
export function ThemeToggle({ testId = "theme-toggle" }: { testId?: string }): ReactNode {
  const { theme, setTheme } = usePlatform();
  const dark = isDark(theme, useDarkScheme());
  return (
    <button
      type="button"
      className={`${s.tbtn} ${s.iconOnly}`}
      aria-pressed={dark}
      aria-label={shell.darkTheme}
      title={dark ? shell.toLight : shell.toDark}
      data-testid={testId}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={s.icon}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={s.icon}>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}

export interface TopBarProps {
  /** Serif title next to the mark (a system name); plain screen titles stay in the page. */
  title?: ReactNode;
  /** Screen actions on the right, before the navigation (on a phone — their own row under it). */
  actions?: ReactNode;
  /** Cabinet navigation «Системы · Тарифы»; off on public and staff pages. */
  nav?: boolean;
}

/** Floating glass top bar of the platform screens. */
export function TopBar({ title, actions, nav = true }: TopBarProps): ReactNode {
  const { route } = useRoute();
  return (
    <Glass as="header" className={s.top} testId="platform-top">
      <AppLink to="/" className={s.brand} label={shell.home} testId="platform-home">
        <BrandMark />
        <span className={nav ? s.wm : undefined}>{shell.brand}</span>
      </AppLink>
      {title !== undefined && title !== null && (
        <span className={s.sys}>
          <Serif as="span" size="md" className={s.sysName} testId="platform-title">
            {title}
          </Serif>
        </span>
      )}
      <span className={s.grow} />
      {actions !== undefined && actions !== null && <span className={s.actions}>{actions}</span>}
      {nav && (
        <nav className={s.nav} aria-label={shell.navLabel}>
          <AppLink to="/" className={s.tbtn} current={route.name === "start"} testId="platform-nav-systems">
            {shell.systems}
          </AppLink>
          <AppLink
            to="/billing"
            className={s.tbtn}
            current={route.name === "billing"}
            testId="platform-nav-billing"
          >
            {shell.billing}
          </AppLink>
        </nav>
      )}
      <ThemeToggle />
    </Glass>
  );
}

export interface PlatformPageProps extends TopBarProps {
  children: ReactNode;
  testId?: string;
}

/** A platform screen: the top bar and the page under it (the screen renders its own <main>). */
export function PlatformPage({ children, testId, ...bar }: PlatformPageProps): ReactNode {
  return (
    <div className={s.frame} data-testid={testId}>
      <TopBar {...bar} />
      {children}
    </div>
  );
}
