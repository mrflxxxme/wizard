// Logos (ui-kit.yaml#components.Logos, B2-35): partners and clients by name (a picture when the owner uploads one) —
// one row, tiles, or a slow running line (marquee: still and wrapped with prefers-reduced-motion, paused on hover).
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { hasPicture } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { LogoItem, LogosProps } from "./types.js";

function Logo(props: { item: LogoItem }): ReactNode {
  const { item } = props;
  return hasPicture(item.image) ? (
    <span className={s.logoPic}>
      <ImageImpl
        root={part("wz-logos-image")}
        {...item.image}
        alt={item.image.alt || item.name}
        ratio="3/2"
        fit="contain"
        rounded={false}
      />
    </span>
  ) : (
    <span className={s.logoName}>{item.name}</span>
  );
}

export function Logos(props: LogosProps): ReactNode {
  const root = useWzRoot("Logos", "wz-logos", props);
  const id = useHeadingId("logos");
  const variant = props.variant ?? "row";
  let body: ReactNode;
  if (variant === "marquee")
    body = (
      <div className={s.marquee}>
        <ul className={s.marqueeTrack}>
          {props.items.map((it) => (
            <li key={it.name} data-testid="wz-logos-item">
              <Logo item={it} />
            </li>
          ))}
          {/* The second copy makes the loop seamless; screen readers hear the list once. */}
          {props.items.map((it) => (
            <li key={`copy:${it.name}`} aria-hidden="true">
              <Logo item={it} />
            </li>
          ))}
        </ul>
      </div>
    );
  else
    body = (
      <ul className={variant === "grid" ? s.logoGrid : s.logoRow}>
        {props.items.map((it) => (
          <li
            key={it.name}
            className={cx(variant === "grid" && cx(s.logoTile, s.surface))}
            data-testid="wz-logos-item"
          >
            <Logo item={it} />
          </li>
        ))}
      </ul>
    );
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      {props.title ? (
        <BlockHead id={id} title={props.title} />
      ) : (
        <h2 id={id} className={s.srOnly}>
          {ru.blocks.logos}
        </h2>
      )}
      {body}
    </Section>
  );
}
