// Faq (ui-kit.yaml#components.Faq, M2-43): questions and answers — native <details> (keyboard and screen readers work
// without scripts) or all answers in two columns (<dl>).
import type { ReactNode } from "react";
import { useWzRoot } from "../../data/context.js";
import s from "./Blocks.module.css";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { FaqProps } from "./types.js";

export function Faq(props: FaqProps): ReactNode {
  const root = useWzRoot("Faq", "wz-faq", props);
  const id = useHeadingId("faq");
  const columns = props.variant === "columns";
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={!columns}
    >
      <BlockHead id={id} title={props.title} />
      {columns ? (
        <dl className={s.qa}>
          {props.items.map((q) => (
            <div key={q.question} data-testid="wz-faq-item">
              <dt>{q.question}</dt>
              <dd>{q.answer}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <ul className={s.faqList}>
          {props.items.map((q) => (
            <li key={q.question} data-testid="wz-faq-item">
              <details className={s.details}>
                <summary className={s.summary}>{q.question}</summary>
                <p className={s.answer}>{q.answer}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
