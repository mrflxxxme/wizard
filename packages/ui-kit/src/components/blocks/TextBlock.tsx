// TextBlock (ui-kit.yaml#components.TextBlock, B2-35): a text of the owner — a narrow column, two columns on large
// screens, or a large quotation.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import s from "./Blocks.module.css";
import { Paragraphs } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { TextBlockProps } from "./types.js";

export function TextBlock(props: TextBlockProps): ReactNode {
  const root = useWzRoot("TextBlock", "wz-textblock", props);
  const id = useHeadingId("text");
  const variant = props.variant ?? "plain";
  const head = props.title ? (
    <BlockHead id={id} title={props.title} />
  ) : (
    <h2 id={id} className={s.srOnly}>
      {props.text.split(/\s+/).slice(0, 6).join(" ")}
    </h2>
  );
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant === "plain"}
    >
      {head}
      {variant === "quote" ? (
        <blockquote className={s.pullQuote}>
          <Paragraphs text={props.text} />
        </blockquote>
      ) : (
        <div className={cx(s.prose, variant === "two_columns" && s.twoColumns)}>
          <Paragraphs text={props.text} />
        </div>
      )}
    </Section>
  );
}
