// Team (ui-kit.yaml#components.Team, B2-35): people or roles as the owner names them — cards with a portrait, round
// portraits in a row, or rows with a text. Without a photo a monogram stands on the theme graphic (no stock people).
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { hasPicture, Media, monogram } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { TeamMember, TeamProps } from "./types.js";

function Avatar(props: { member: TeamMember }): ReactNode {
  const { member } = props;
  return (
    <span className={s.avatar} aria-hidden={hasPicture(member.image) ? undefined : "true"}>
      {hasPicture(member.image) ? (
        <ImageImpl root={part("wz-team-image")} {...member.image} ratio="1/1" rounded={false} />
      ) : (
        <span className={s.monogram}>{monogram(member.name)}</span>
      )}
    </span>
  );
}

export function Team(props: TeamProps): ReactNode {
  const root = useWzRoot("Team", "wz-team", props);
  const id = useHeadingId("team");
  const variant = props.variant ?? "cards";
  const info = (m: TeamMember) => (
    <>
      <h3 className={s.h3}>{m.name}</h3>
      {m.role && <p className={s.role}>{m.role}</p>}
      {m.text && <p className={s.text}>{m.text}</p>}
    </>
  );
  let body: ReactNode;
  if (variant === "row")
    body = (
      <ul className={s.memberRow}>
        {props.items.map((m) => (
          <li key={m.name} className={s.member} data-testid="wz-team-item">
            <Avatar member={m} />
            {info(m)}
          </li>
        ))}
      </ul>
    );
  else if (variant === "list")
    body = (
      <ul className={s.memberList}>
        {props.items.map((m) => (
          <li key={m.name} className={s.memberListItem} data-testid="wz-team-item">
            <Avatar member={m} />
            <div>{info(m)}</div>
          </li>
        ))}
      </ul>
    );
  else
    body = (
      <ul className={cx(s.grid, s.cols3)}>
        {props.items.map((m) => (
          <li key={m.name} className={cx(s.memberCard, s.surface)} data-testid="wz-team-item">
            <Media
              image={m.image}
              ratio="4/3"
              testId="wz-team-image"
              rounded={false}
              label={hasPicture(m.image) ? undefined : monogram(m.name)}
              sizes="(max-width: 640px) 100vw, 400px"
            />
            <div className={s.cardBody}>{info(m)}</div>
          </li>
        ))}
      </ul>
    );
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      <BlockHead id={id} title={props.title} intro={props.intro} />
      {body}
    </Section>
  );
}
