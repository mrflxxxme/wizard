// CabinetLayout (ui-kit.yaml#components.CabinetLayout): personal area with keyboard tabs, active section in #hash.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cx, useRoleSpec, useWzRoot, useWzUser } from "../data/context.js";
import { ru } from "../i18n/ru.js";
import styles from "./CabinetLayout.module.css";
import { ErrorState, useLoginAction } from "./States.js";
import type { CabinetLayoutProps } from "./types.js";

function hashSection(ids: string[]): string | undefined {
  if (typeof window === "undefined") return undefined;
  const h = decodeURIComponent(window.location.hash.slice(1));
  return ids.includes(h) ? h : undefined;
}

/** Runtime page of a logged-in user: consent withdrawal (runtime.yaml#service_endpoints.privacy). */
export const PRIVACY_PAGE = "/_wizard/privacy";
const MY_DATA = "mydata";

/**
 * «Мои данные» (ui-kit.yaml#components.CabinetLayout, M2): the policy page and /_wizard/privacy. Both are runtime
 * pages, not SPA routes, so the links navigate the browser.
 */
function MyData({ policyPage }: { policyPage: string | undefined }): ReactNode {
  return (
    <div className={styles.mydata} data-testid="wz-cabinet-mydata">
      <p>{ru.cabinet.myDataHint}</p>
      <ul>
        {policyPage && (
          <li>
            <a href={policyPage} data-testid="wz-cabinet-mydata-policy">
              {ru.appShell.policy}
            </a>
          </li>
        )}
        <li>
          <a href={PRIVACY_PAGE} data-testid="wz-cabinet-mydata-privacy">
            {ru.cabinet.myDataManage}
          </a>
        </li>
      </ul>
    </div>
  );
}

export function CabinetLayout(input: CabinetLayoutProps): ReactNode {
  const root = useWzRoot("CabinetLayout", "wz-cabinet", input);
  const spec = useRoleSpec();
  const props: CabinetLayoutProps = input.sections.some((s) => s.id === MY_DATA)
    ? input
    : {
        ...input,
        sections: [
          ...input.sections,
          {
            id: MY_DATA,
            label: ru.cabinet.myData,
            content: <MyData policyPage={spec.compliance?.policyPage} />,
          },
        ],
      };
  const { user, isLoading } = useWzUser();
  const login = useLoginAction();
  const ids = props.sections.map((s) => s.id);
  const [active, setActive] = useState(() => hashSection(ids) ?? props.defaultSection ?? ids[0] ?? "");
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const base = (root["data-wz-id"] ?? "cabinet").replace(/[^A-Za-z0-9_-]/g, "_");

  useEffect(() => {
    const on = () => {
      const h = hashSection(props.sections.map((s) => s.id));
      if (h) setActive(h);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [props.sections]);

  const select = (id: string, focus = false) => {
    setActive(id);
    if (typeof window !== "undefined")
      window.history.replaceState(window.history.state, "", `#${encodeURIComponent(id)}`);
    if (focus) tabs.current[id]?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const i = ids.indexOf(active);
    const next: Record<string, number> = {
      ArrowRight: i + 1,
      ArrowDown: i + 1,
      ArrowLeft: i - 1,
      ArrowUp: i - 1,
      Home: 0,
      End: ids.length - 1,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    const j = ((next[e.key] as number) + ids.length) % ids.length;
    select(ids[j] as string, true);
  };

  if (!user && !isLoading)
    return (
      <section {...root} className={cx(styles.cabinet, props.className)}>
        <ErrorState error={{ code: "UNAUTHENTICATED", message: "", status: 401 }} onLogin={login} />
      </section>
    );

  const current = props.sections.find((s) => s.id === active) ?? props.sections[0];
  return (
    <section {...root} className={cx(styles.cabinet, props.className)} aria-labelledby={`${base}-title`}>
      <h1 id={`${base}-title`} className={styles.title}>
        {props.title ?? ru.cabinet.title}
      </h1>
      <div className={styles.layout}>
        <div className={styles.tabs} role="tablist" aria-label={ru.cabinet.sections} onKeyDown={onKey}>
          {props.sections.map((s) => (
            <button
              key={s.id}
              ref={(el) => {
                tabs.current[s.id] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${s.id}`}
              aria-selected={s.id === current?.id}
              aria-controls={`${base}-panel`}
              tabIndex={s.id === current?.id ? 0 : -1}
              className={styles.tab}
              data-testid={`wz-cabinet-tab-${s.id}`}
              onClick={() => select(s.id)}
            >
              <span>{s.label}</span>
              {s.count !== undefined && <span className={styles.count}>{s.count}</span>}
            </button>
          ))}
        </div>
        <div
          id={`${base}-panel`}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${current?.id}`}
        >
          {current?.content}
        </div>
      </div>
    </section>
  );
}
