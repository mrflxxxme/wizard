// Contacts (ui-kit.yaml#components.Contacts, B2-35): address, phone, e-mail, hours and messengers as the owner gives
// them — in a card, next to a map placeholder (split), or in columns. The phone and e-mail are links; the map is a link
// «Открыть в Яндекс Картах» (no request to the map service until the visitor follows it).
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { BlockIcon } from "./parts.js";
import { Section, useHeadingId } from "./Section.js";
import type { BlockIconName, ContactsProps } from "./types.js";

type Row = { key: string; label: string; icon: BlockIconName; value: ReactNode };

const tel = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;
/** A messenger line is a link when it is one (https://…, t.me/…); otherwise plain text. */
function messenger(m: string): ReactNode {
  const tme = m.match(/(?:^|\s)(t\.me\/\S+)/)?.[1];
  const url = m.match(/https?:\/\/\S+/)?.[0] ?? (tme ? `https://${tme}` : undefined);
  return url ? <a href={url}>{m}</a> : m;
}

/** Link to the address on Yandex Maps (a plain link: the page itself loads nothing from the map service). */
export const mapHref = (address: string) => `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`;

export function Contacts(props: ContactsProps): ReactNode {
  const root = useWzRoot("Contacts", "wz-contacts", props);
  const id = useHeadingId("contacts");
  const variant = props.variant ?? "card";
  const rows: Row[] = [];
  if (props.address)
    rows.push({ key: "address", label: ru.blocks.address, icon: "pin", value: props.address });
  if (props.phone)
    rows.push({
      key: "phone",
      label: ru.blocks.phone,
      icon: "phone",
      value: <a href={tel(props.phone)}>{props.phone}</a>,
    });
  if (props.email)
    rows.push({
      key: "email",
      label: ru.blocks.email,
      icon: "chat",
      value: <a href={`mailto:${props.email}`}>{props.email}</a>,
    });
  if (props.hours) rows.push({ key: "hours", label: ru.blocks.hours, icon: "clock", value: props.hours });
  for (const [i, m] of (props.messengers ?? []).entries())
    rows.push({ key: `m${i}`, label: ru.blocks.messengers, icon: "chat", value: messenger(m) });
  const list = (
    <dl className={cx(s.contactList, variant === "columns" && s.contactCols)}>
      {rows.map((r) => (
        <div key={r.key} data-testid={`wz-contacts-${r.key}`}>
          <BlockIcon name={r.icon} className={s.contactIcon} />
          <dt className={s.contactLabel}>{r.label}</dt>
          <dd className={s.contactValue}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
  const heading = (
    <div className={s.head}>
      <h2 id={id} className={s.h2}>
        {props.title}
      </h2>
    </div>
  );
  let body: ReactNode;
  if (variant === "split")
    body = (
      <div className={s.heroSplit}>
        <div>
          {heading}
          {list}
        </div>
        <div className={s.mapBox}>
          {props.address && (
            <a className={s.btn} href={mapHref(props.address)} target="_blank" rel="noopener noreferrer">
              {ru.blocks.openMap}
            </a>
          )}
        </div>
      </div>
    );
  else if (variant === "columns")
    body = (
      <>
        {heading}
        {list}
      </>
    );
  else
    body = (
      <div className={cx(s.formCard, s.surface)}>
        {heading}
        {list}
        {props.address && (
          <p className={s.note}>
            <a href={mapHref(props.address)} target="_blank" rel="noopener noreferrer">
              {ru.blocks.openMap}
            </a>
          </p>
        )}
      </div>
    );
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant === "card"}
    >
      {body}
    </Section>
  );
}
