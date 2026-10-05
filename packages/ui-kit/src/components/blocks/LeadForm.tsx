// LeadForm (ui-kit.yaml#components.LeadForm, M2-43): the lead form of a landing page over the SDK create hook
// (DataSource.useCreate → useEntityMutation(entity).create). Fields, validation and the personal data consent are those
// of RecordForm: with a pii field and a non-admin role the consent checkbox is shown and nothing is sent without it;
// create goes with {consent: true} (G2-PII-04, compliance.yaml#system_package.consent).
import { type ReactNode, useState } from "react";
import { cx, useCan, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import { RecordFormImpl } from "../RecordForm.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { Section, useHeadingId } from "./Section.js";
import type { LeadFormProps } from "./types.js";

export function LeadForm(props: LeadFormProps): ReactNode {
  const root = useWzRoot("LeadForm", "wz-leadform", props);
  const id = useHeadingId("lead");
  const can = useCan();
  const [sent, setSent] = useState(false);
  const [round, setRound] = useState(0);
  const variant = props.variant ?? "card";
  const allowed = can("create", props.entity);

  const head = (
    <div className={s.head}>
      <h2 id={id} className={s.h2}>
        {props.title ?? ru.blocks.leadTitle}
      </h2>
      {props.intro && <p className={s.lead}>{props.intro}</p>}
      {variant === "split" && props.contacts && props.contacts.length > 0 && (
        <dl className={s.contacts} aria-label={ru.blocks.contacts}>
          {props.contacts.map((c) => (
            <div key={`${c.label}:${c.value}`}>
              <dt>{c.label}</dt>
              <dd>{c.href ? <a href={c.href}>{c.value}</a> : c.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {variant === "split" && props.aside}
    </div>
  );

  const form = !allowed ? (
    <p className={s.text} data-testid="wz-leadform-unavailable">
      {ru.blocks.leadUnavailable}
    </p>
  ) : sent ? (
    <div className={s.success} role="status" data-testid="wz-leadform-success">
      <h3 className={s.h3}>{ru.blocks.leadSentTitle}</h3>
      <p className={s.text}>{props.successText ?? ru.blocks.leadSentText}</p>
      <button
        type="button"
        className={s.linkButton}
        onClick={() => {
          setSent(false);
          setRound((r) => r + 1);
        }}
      >
        {ru.blocks.leadAgain}
      </button>
    </div>
  ) : (
    <RecordFormImpl
      key={round}
      root={part("wz-leadform-form")}
      testBase="leadform"
      entity={props.entity}
      mode="create"
      {...(props.fields ? { fields: props.fields } : {})}
      {...(props.hidden ? { hidden: props.hidden } : {})}
      submitLabel={props.submitLabel ?? ru.blocks.leadSubmit}
      initial={{}}
      onSuccess={(rec) => {
        setSent(true);
        props.onSuccess?.(rec);
      }}
    />
  );

  const card = variant !== "inline" ? <div className={s.formCard}>{form}</div> : form;
  return (
    <Section
      root={root}
      anchor={props.anchor ?? "lead"}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant !== "split"}
    >
      {variant === "split" ? (
        <div className={cx(s.leadSplit)}>
          {head}
          {card}
        </div>
      ) : (
        <>
          {head}
          {card}
        </>
      )}
    </Section>
  );
}
