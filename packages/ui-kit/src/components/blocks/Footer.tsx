// Footer (ui-kit.yaml#components.Footer, M2-43): brand, links, contacts, the owner's legal line and the link to the
// personal data policy (compliance.policyPage) when the system collects personal data.
import type { ReactNode } from "react";
import { cx, useRoleSpec, useWzRoot } from "../../data/context.js";
import { hasPii } from "../../data/roleSpec.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import type { FooterProps } from "./types.js";

export function Footer(props: FooterProps): ReactNode {
  const root = useWzRoot("Footer", "wz-footer", props);
  const spec = useRoleSpec();
  const policyPage = spec.compliance?.policyPage;
  const piiInSpec = spec.entities.some((e) => e.fields.some(hasPii));
  const showPolicy = props.showPolicy ?? piiInSpec;
  const policy = showPolicy && policyPage && (
    // Runtime page (compliance.policyPage), not an SPA route: the browser navigates.
    <a href={policyPage} data-testid="wz-footer-policy">
      {ru.blocks.policy}
    </a>
  );
  const contacts = props.contacts?.length ? (
    <div>
      <h2 className={s.footerTitle}>{ru.blocks.contacts}</h2>
      <ul className={s.footerList}>
        {props.contacts.map((c) => (
          <li key={`${c.label}:${c.value}`}>
            {c.href ? (
              <a className={s.footerLink} href={c.href}>
                {`${c.label}: ${c.value}`}
              </a>
            ) : (
              <span className={s.footerLink}>{`${c.label}: ${c.value}`}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <footer {...root} className={cx(s.footer, props.className)}>
      <div className={s.container}>
        {props.variant === "columns" ? (
          <div className={s.footerTop}>
            <div>
              <p className={s.footerBrand}>{props.brand}</p>
              {props.text && <p className={s.text}>{props.text}</p>}
            </div>
            {(props.columns ?? []).map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <h2 className={s.footerTitle}>{col.title}</h2>
                <ul className={s.footerList}>
                  {col.links.map((l) => (
                    <li key={`${l.href}:${l.label}`}>
                      <a className={s.footerLink} href={l.href}>
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
            {contacts}
          </div>
        ) : (
          <div className={s.footerSimple}>
            <p className={s.footerBrand}>{props.brand}</p>
            {(props.columns ?? []).length > 0 && (
              <nav aria-label={ru.blocks.footerNav}>
                <ul className={cx(s.footerList)}>
                  {(props.columns ?? [])
                    .flatMap((c) => c.links)
                    .map((l) => (
                      <li key={`${l.href}:${l.label}`}>
                        <a className={s.footerLink} href={l.href}>
                          {l.label}
                        </a>
                      </li>
                    ))}
                </ul>
              </nav>
            )}
            {contacts}
          </div>
        )}
        {(props.legal || policy) && (
          <div className={s.footerBottom}>
            {props.legal && <span>{props.legal}</span>}
            {policy}
          </div>
        )}
      </div>
    </footer>
  );
}
