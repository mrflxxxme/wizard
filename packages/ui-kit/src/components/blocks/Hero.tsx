// Hero (ui-kit.yaml#components.Hero, M2-43): the first screen — the page's only <h1>, offer, actions, picture.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { Actions, Section, useHeadingId } from "./Section.js";
import type { HeroProps } from "./types.js";

export function Hero(props: HeroProps): ReactNode {
  const root = useWzRoot("Hero", "wz-hero", props);
  const id = useHeadingId("hero");
  const { title, subtitle, eyebrow, primary, secondary, image, variant = "split", tone = "default" } = props;
  const hasImage = !!image && !!(image.fileId || image.src);
  const text = (centered: boolean) => (
    <div className={cx(centered && s.centered)}>
      {eyebrow && <p className={s.eyebrow}>{eyebrow}</p>}
      <h1 id={id} className={s.h1}>
        {title}
      </h1>
      {subtitle && <p className={s.lead}>{subtitle}</p>}
      <Actions primary={primary} secondary={secondary} testBase="wz-hero" />
    </div>
  );

  if (variant === "cover") {
    return (
      <section
        {...root}
        id={props.anchor}
        aria-labelledby={id}
        className={cx(s.cover, props.className)}
        data-variant="cover"
      >
        {hasImage && image && (
          <div className={s.coverMedia}>
            <ImageImpl
              root={part("wz-hero-image")}
              {...image}
              ratio="auto"
              sizes="100vw"
              priority
              rounded={false}
            />
          </div>
        )}
        <div className={s.coverBody}>
          <div className={s.container}>{text(false)}</div>
        </div>
      </section>
    );
  }

  const media =
    hasImage && image ? (
      <div className={s.heroMedia}>
        <ImageImpl root={part("wz-hero-image")} {...image} ratio="4/3" priority />
      </div>
    ) : null;
  return (
    <Section root={root} anchor={props.anchor} tone={tone} labelledBy={id} className={props.className}>
      {variant === "centered" ? (
        <>
          {text(true)}
          {media && <div className={s.heroBelow}>{media}</div>}
        </>
      ) : (
        <div className={s.heroSplit}>
          {text(false)}
          {media}
        </div>
      )}
    </Section>
  );
}
