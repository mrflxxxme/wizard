// GoalHints (ui-kit.yaml#components.GoalHints, B2-27): hints «что улучшить» on the goal panel of a cabinet — up to three
// cards, each with what happened, what to do and a link to the action (a cabinet section or the platform in a new tab).
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../data/context.js";
import { ru } from "../i18n/ru.js";
import styles from "./GoalHints.module.css";
import { cabinetLook, useCabinetLook } from "./look.js";
import { EmptyState } from "./States.js";
import type { GoalHintsProps } from "./types.js";

export function GoalHints(props: GoalHintsProps): ReactNode {
  const root = useWzRoot("GoalHints", "wz-goalhints", props);
  useCabinetLook();
  const title = props.title ?? ru.goalHints.title;
  return (
    <section {...root} {...cabinetLook} className={cx(styles.hints, props.className)}>
      <header className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {props.subtitle && <p className={styles.subtitle}>{props.subtitle}</p>}
      </header>
      {props.items.length === 0 ? (
        <EmptyState text={props.emptyText ?? ru.goalHints.empty} />
      ) : (
        <ol className={styles.list}>
          {props.items.map((h) => (
            <li key={h.id} className={styles.item} data-testid={`wz-goalhints-item-${h.id}`}>
              <h3 className={styles.itemTitle}>{h.title}</h3>
              <p className={styles.text}>{h.text}</p>
              <a
                className={styles.action}
                href={h.action.href}
                data-testid={`wz-goalhints-action-${h.id}`}
                {...(h.action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                <span>{h.action.label}</span>
                {h.action.external && (
                  <>
                    <span aria-hidden="true">↗</span>
                    <span className={styles.srOnly}>{` (${ru.goalHints.newTab})`}</span>
                  </>
                )}
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
