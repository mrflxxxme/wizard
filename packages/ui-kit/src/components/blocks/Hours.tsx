// Hours (ui-kit.yaml#components.Hours, B2-35): opening hours as the owner gives them — a two-column table, a card per
// row, or one line.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { HoursProps } from "./types.js";

export function Hours(props: HoursProps): ReactNode {
  const root = useWzRoot("Hours", "wz-hours", props);
  const id = useHeadingId("hours");
  const variant = props.variant ?? "table";
  const title = props.title ?? ru.blocks.hours;
  let body: ReactNode;
  if (variant === "cards")
    body = (
      <ul className={s.hoursCards}>
        {props.items.map((it) => (
          <li key={it.day} className={cx(s.hoursCard, s.surface)} data-testid="wz-hours-item">
            <span className={s.hoursDay}>{it.day}</span>
            <span className={s.hoursTime}>{it.time}</span>
          </li>
        ))}
      </ul>
    );
  else if (variant === "inline")
    body = (
      <ul className={s.hoursInline}>
        {props.items.map((it) => (
          <li key={it.day} data-testid="wz-hours-item">
            <span className={s.hoursDay}>{it.day}</span>
            <span className={s.hoursTime}>{it.time}</span>
          </li>
        ))}
      </ul>
    );
  else
    body = (
      <table className={s.hoursTable}>
        <tbody>
          {props.items.map((it) => (
            <tr key={it.day} data-testid="wz-hours-item">
              <th scope="row">{it.day}</th>
              <td>{it.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant !== "cards"}
    >
      <BlockHead id={id} title={title} />
      {body}
    </Section>
  );
}
