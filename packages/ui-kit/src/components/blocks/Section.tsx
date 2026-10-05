// Shared frame of the landing blocks: <section> labelled by its heading, tone, centred container (internal, M2-43).
import { type ReactNode, useId } from "react";
import { cx } from "../../data/context.js";
import type { RootAttrs } from "../root.js";
import s from "./Blocks.module.css";
import type { BlockLink, BlockTone } from "./types.js";

export const toneClass = (tone: BlockTone | undefined) =>
  tone === "alt" ? s.alt : tone === "accent" ? s.accent : undefined;

export function Section(props: {
  root: RootAttrs;
  anchor?: string | undefined;
  tone?: BlockTone | undefined;
  className?: string | undefined;
  labelledBy: string;
  narrow?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      {...props.root}
      id={props.anchor}
      aria-labelledby={props.labelledBy}
      className={cx(s.section, toneClass(props.tone), props.className)}
    >
      <div className={cx(s.container, props.narrow && s.narrow)}>{props.children}</div>
    </section>
  );
}

/** Heading id unique on the page (React useId), safe for aria-labelledby. */
export function useHeadingId(name: string): string {
  return `wz-${name}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Title + optional intro of a block. */
export function BlockHead(props: {
  id: string;
  title: string;
  intro?: string | undefined;
  centered?: boolean;
}) {
  return (
    <div className={cx(s.head, props.centered && s.centered)}>
      <h2 id={props.id} className={s.h2}>
        {props.title}
      </h2>
      {props.intro && <p className={s.lead}>{props.intro}</p>}
    </div>
  );
}

/** Action links of a block (primary and secondary look like buttons). */
export function Actions(props: {
  primary?: BlockLink | undefined;
  secondary?: BlockLink | undefined;
  testBase: string;
}) {
  if (!props.primary && !props.secondary) return null;
  return (
    <div className={s.actions}>
      {props.primary && (
        <a className={s.btn} href={props.primary.href} data-testid={`${props.testBase}-primary`}>
          {props.primary.label}
        </a>
      )}
      {props.secondary && (
        <a
          className={cx(s.btn, s.btnSecondary)}
          href={props.secondary.href}
          data-testid={`${props.testBase}-secondary`}
        >
          {props.secondary.label}
        </a>
      )}
    </div>
  );
}
