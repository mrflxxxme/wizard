// Stats (ui-kit.yaml#components.Stats, B2-35): 2–4 facts from the brief — numbers in a row with dividers, in cards,
// or on a band of the brand colour.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { StatsProps } from "./types.js";

export function Stats(props: StatsProps): ReactNode {
  const root = useWzRoot("Stats", "wz-stats", props);
  const id = useHeadingId("stats");
  const variant = props.variant ?? "row";
  const tone = props.tone ?? (variant === "band" ? "accent" : undefined);
  return (
    <Section root={root} anchor={props.anchor} tone={tone} labelledBy={id} className={props.className}>
      {props.title ? (
        <BlockHead id={id} title={props.title} />
      ) : (
        <h2 id={id} className={s.srOnly}>
          {ru.blocks.stats}
        </h2>
      )}
      <ul className={cx(s.stats, variant === "row" && s.statRow)}>
        {props.items.map((it) => (
          <li
            key={`${it.value}:${it.label}`}
            className={cx(s.stat, variant === "cards" && cx(s.statCard, s.surface))}
            data-testid="wz-stats-item"
          >
            <span className={s.statValue}>{it.value}</span>
            <span className={s.statLabel}>{it.label}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
