// Cta (ui-kit.yaml#components.Cta, M2-43): a call to action — a full-width stripe or a card in the brand colour.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import s from "./Blocks.module.css";
import { Actions, Section, useHeadingId } from "./Section.js";
import type { CtaProps } from "./types.js";

export function Cta(props: CtaProps): ReactNode {
  const root = useWzRoot("Cta", "wz-cta", props);
  const id = useHeadingId("cta");
  const card = props.variant === "card";
  const body = (
    <div className={cx(s.centered, card && cx(s.ctaCard, s.accent))}>
      <h2 id={id} className={s.h2}>
        {props.title}
      </h2>
      {props.text && <p className={s.lead}>{props.text}</p>}
      <Actions primary={props.action} secondary={props.secondary} testBase="wz-cta" />
    </div>
  );
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={card ? (props.tone ?? "default") : (props.tone ?? "accent")}
      labelledBy={id}
      className={props.className}
    >
      {body}
    </Section>
  );
}
