// LandingSection (ui-kit.yaml#components.LandingSection, B2-35): the frame of a landing section around content of a
// module (the catalog showcase): spacing, tone, container and the heading of the blocks; h1 when it is the page itself.
// With `tabs` a row of toggle buttons (aria-pressed, ≥ 44 px) filters the content — the showcase «tabs» by sections.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import s from "./Blocks.module.css";
import { Section, useHeadingId } from "./Section.js";
import type { LandingSectionProps } from "./types.js";

export function LandingSection(props: LandingSectionProps): ReactNode {
  const root = useWzRoot("LandingSection", "wz-section", props);
  const id = useHeadingId("section");
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      <div className={s.head}>
        {props.main ? (
          <h1 id={id} className={s.h1}>
            {props.title}
          </h1>
        ) : (
          <h2 id={id} className={s.h2}>
            {props.title}
          </h2>
        )}
        {props.intro && <p className={s.lead}>{props.intro}</p>}
      </div>
      {props.tabs && props.tabs.length > 1 && (
        <div className={s.tabs} data-testid="wz-section-tabs">
          {props.tabs.map((t) => {
            const on = (props.tab ?? null) === t.id;
            return (
              <button
                key={t.id ?? "all"}
                type="button"
                className={cx(s.tab, on && s.tabOn)}
                aria-pressed={on}
                onClick={() => props.onTab?.(t.id)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}
      {props.children}
    </Section>
  );
}
