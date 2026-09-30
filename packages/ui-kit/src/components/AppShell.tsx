// AppShell (ui-kit.yaml#components.AppShell): navigation from RoleSpec, drawer on sm/md, user menu, login page.
import { matchRoute } from "@wizard/sdk";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  cx,
  useLocation,
  useNavigate,
  useRoleSpec,
  useWzRoot,
  useWzUser,
  type WzBase,
} from "../data/context.js";
import { hasPii, roleLabel } from "../data/roleSpec.js";
import { maskPhone } from "../format.js";
import { ru } from "../i18n/ru.js";
import styles from "./AppShell.module.css";
import { ButtonImpl } from "./Button.js";
import { Login } from "./Login.js";
import { part } from "./root.js";

export type NavItem = { route: string; title: string; icon?: string; badge?: number };

export interface AppShellProps extends WzBase {
  nav?: NavItem[];
  title?: string;
  logoSrc?: string;
  footer?: ReactNode;
  children: ReactNode;
}

const PHONE_LIKE = /^\+?[\d\s()-]{10,}$/;

export function AppShell(props: AppShellProps): ReactNode {
  const root = useWzRoot("AppShell", "wz-appshell", props);
  const spec = useRoleSpec();
  const { user, logout } = useWzUser();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const nav: NavItem[] =
    props.nav ??
    spec.pages
      .filter((p) => p.nav !== false && !p.route.includes(":"))
      .map((p) => ({ route: p.route, title: p.title }));
  const loginRoles = spec.roles.some((r) => r.access === "login");
  const piiInSpec = spec.entities.some((e) => e.fields.some(hasPii));
  const policyPage = spec.compliance?.policyPage;
  const known = spec.pages.length === 0 || spec.pages.some((p) => matchRoute(p.route, pathname) !== null);
  const isLogin = pathname === "/login";

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  useEffect(() => {
    if (open) navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!known && !isLogin && !user && loginRoles) navigate(`/login?next=${encodeURIComponent(pathname)}`);
  }, [known, isLogin, user, loginRoles, navigate, pathname]);

  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>("a, button") ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const go = (to: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    setOpen(false);
    navigate(to);
  };

  const display = user
    ? PHONE_LIKE.test(user.displayName)
      ? maskPhone(user.displayName)
      : user.displayName
    : "";
  let content: ReactNode = props.children;
  if (isLogin) content = <Login />;
  else if (!known && user) content = <p className={styles.forbidden}>{ru.appShell.forbidden}</p>;

  return (
    <div {...root} className={cx(styles.shell, props.className)} data-drawer={open ? "open" : "closed"}>
      <header className={styles.topbar}>
        <button
          ref={toggleRef}
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${root["data-wz-id"]}-nav`}
          data-testid="wz-appshell-menu-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.burger} aria-hidden="true" />
          {ru.appShell.menu}
        </button>
        <a className={styles.brand} href="/" onClick={go("/")}>
          {(props.logoSrc ?? spec.theme?.logoFile) && (
            <img className={styles.logo} src={props.logoSrc ?? `/assets/${spec.theme?.logoFile}`} alt="" />
          )}
          <span>{props.title ?? spec.app.name}</span>
        </a>
        <div className={styles.user} data-testid="wz-appshell-user">
          {user ? (
            <>
              <span className={styles.who}>
                <span className={styles.name}>{display}</span>
                <span className={styles.role}>{roleLabel(spec, user.role)}</span>
              </span>
              <ButtonImpl
                root={part("wz-appshell-logout")}
                size="sm"
                variant="ghost"
                onClick={() => void logout()}
              >
                {ru.appShell.logout}
              </ButtonImpl>
            </>
          ) : (
            loginRoles &&
            !isLogin && (
              <ButtonImpl
                root={part("wz-appshell-login")}
                size="sm"
                variant="primary"
                onClick={() => navigate(`/login?next=${encodeURIComponent(pathname)}`)}
              >
                {ru.appShell.login}
              </ButtonImpl>
            )
          )}
        </div>
      </header>
      {open && <div className={styles.backdrop} aria-hidden="true" onClick={close} />}
      <nav
        ref={navRef}
        id={`${root["data-wz-id"]}-nav`}
        className={styles.nav}
        aria-label={ru.appShell.nav}
        data-testid="wz-appshell-nav"
        onKeyDown={onNavKey}
        {...(open ? { role: "dialog", "aria-modal": true } : {})}
      >
        <button type="button" className={styles.close} onClick={close} aria-label={ru.appShell.closeMenu}>
          ×
        </button>
        <ul className={styles.list}>
          {nav.map((n) => {
            const active = matchRoute(n.route, pathname) !== null;
            return (
              <li key={n.route}>
                <a
                  href={n.route}
                  className={styles.link}
                  aria-current={active ? "page" : undefined}
                  onClick={go(n.route)}
                >
                  {n.icon && (
                    <span className={styles.icon} aria-hidden="true">
                      {n.icon}
                    </span>
                  )}
                  <span>{n.title}</span>
                  {n.badge !== undefined && n.badge > 0 && <span className={styles.count}>{n.badge}</span>}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className={styles.main}>{content}</main>
      {(props.footer || (piiInSpec && policyPage)) && (
        <footer className={styles.footer}>
          {piiInSpec && policyPage && (
            <a href={policyPage} data-testid="wz-appshell-policy-link" onClick={go(policyPage)}>
              {ru.appShell.policy}
            </a>
          )}
          {props.footer}
        </footer>
      )}
    </div>
  );
}

AppShell.Login = Login;
