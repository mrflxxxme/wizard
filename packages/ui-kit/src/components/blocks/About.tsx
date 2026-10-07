// About (ui-kit.yaml#components.About, B2-35): who the business is, in the owner's words — text and picture side by side
// (the theme graphic without a picture), a narrow text in the middle, or the title on the left and the story on the right.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import s from "./Blocks.module.css";
import { Media, Paragraphs } from "./parts.js";
import { Section, useHeadingId } from "./Section.js";
import type { AboutProps } from "./types.js";

export function About(props: AboutProps): ReactNode {
  const root = useWzRoot("About", "wz-about", props);
  const id = useHeadingId("about");
  const variant = props.variant ?? "split";
  const heading = (
    <h2 id={id} className={s.h2}>
      {props.title}
    </h2>
  );
  let body: ReactNode;
  if (variant === "centered")
    body = (
      <div className={s.centered}>
        <div className={s.head}>{heading}</div>
        <div className={cx(s.prose, s.narrowText)}>
          <Paragraphs text={props.text} />
        </div>
      </div>
    );
  else if (variant === "story")
    body = (
      <div className={s.splitHead}>
        <div>{heading}</div>
        <div className={cx(s.prose, s.storyLead)}>
          <Paragraphs text={props.text} />
        </div>
      </div>
    );
  else
    body = (
      <div className={s.heroSplit}>
        <div>
          <div className={s.head}>{heading}</div>
          <div className={s.prose}>
            <Paragraphs text={props.text} />
          </div>
        </div>
        <Media image={props.image} ratio="4/3" testId="wz-about-image" />
      </div>
    );
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant === "centered"}
    >
      {body}
    </Section>
  );
}
