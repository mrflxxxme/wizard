// Steps (ui-kit.yaml#components.Steps, M2-43, B2-35): how it works — an ordered list in columns, along a line, or in
// cards with a big number.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { StepsProps } from "./types.js";

export function Steps(props: StepsProps): ReactNode {
  const root = useWzRoot("Steps", "wz-steps", props);
  const id = useHeadingId("steps");
  const timeline = props.variant === "timeline";
  if (props.variant === "cards")
    return (
      <Section
        root={root}
        anchor={props.anchor}
        tone={props.tone}
        labelledBy={id}
        className={props.className}
      >
        <BlockHead id={id} title={props.title} intro={props.intro} />
        <ol className={s.steps}>
          {props.steps.map((st, i) => (
            <li key={st.title} className={cx(s.stepCard, s.surface)} data-testid="wz-steps-item">
              <span className={s.bigNumber} aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className={s.h3}>
                <span className={visuallyHidden}>{`${ru.blocks.stepLabel(i + 1)}. `}</span>
                {st.title}
              </h3>
              {st.text && <p className={s.text}>{st.text}</p>}
            </li>
          ))}
        </ol>
      </Section>
    );
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      <BlockHead id={id} title={props.title} intro={props.intro} />
      <ol className={timeline ? s.timeline : s.steps}>
        {props.steps.map((st, i) => (
          <li key={st.title} className={timeline ? s.timelineItem : s.step} data-testid="wz-steps-item">
            <span className={s.stepNumber} aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h3 className={s.h3}>
                <span className={visuallyHidden}>{`${ru.blocks.stepLabel(i + 1)}. `}</span>
                {st.title}
              </h3>
              {st.text && <p className={s.text}>{st.text}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

const visuallyHidden = s.srOnly;
