// Booking (ui-kit.yaml#components.Booking, B2-35): the landing section «Запись на время» — the offer, three steps of
// booking and the action to the booking page (the slot picker lives there, module «Запись по слотам»). Variants: card,
// split, inline.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { Actions, Section, useHeadingId } from "./Section.js";
import type { BookingProps } from "./types.js";

export function Booking(props: BookingProps): ReactNode {
  const root = useWzRoot("Booking", "wz-booking", props);
  const id = useHeadingId("booking");
  const variant = props.variant ?? "card";
  const steps = props.steps?.length ? props.steps : [...ru.blocks.bookingSteps];
  const head = (centered: boolean) => (
    <div className={cx(centered && s.centered)}>
      <h2 id={id} className={s.h2}>
        {props.title}
      </h2>
      {props.intro && <p className={s.lead}>{props.intro}</p>}
    </div>
  );
  const stepList = (
    <ol className={s.bookingSteps}>
      {steps.map((st) => (
        <li key={st} className={s.bookingStep}>
          {st}
        </li>
      ))}
    </ol>
  );
  const action = <Actions primary={props.action} testBase="wz-booking" />;
  let body: ReactNode;
  if (variant === "split")
    body = (
      <div className={s.bookingSplit}>
        {head(false)}
        <div className={cx(s.bookingPanel, s.surface)}>
          {stepList}
          {action}
        </div>
      </div>
    );
  else if (variant === "inline")
    body = (
      <div className={s.bookingInline}>
        {head(false)}
        {action}
      </div>
    );
  else
    body = (
      <div className={cx(s.bookingCard, s.surface)}>
        {head(true)}
        {stepList}
        <div className={s.centered}>{action}</div>
      </div>
    );
  return (
    <Section
      root={root}
      anchor={props.anchor ?? "booking"}
      tone={props.tone ?? (variant === "inline" ? "alt" : undefined)}
      labelledBy={id}
      className={props.className}
    >
      {body}
    </Section>
  );
}
