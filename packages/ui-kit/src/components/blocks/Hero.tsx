// Hero (ui-kit.yaml#components.Hero, M2-43, B2-35): the first screen — the page's only <h1>, offer, actions, picture.
// Variants: split, centered, cover, minimal (typographic poster), collage (2–3 pictures). Without a picture split and
// collage show the theme graphic (photos come with B2-38); on phones the text always comes first.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { hasPicture, Media } from "./parts.js";
import { Actions, Section, useHeadingId } from "./Section.js";
import type { HeroProps } from "./types.js";

export function Hero(props: HeroProps): ReactNode {
  const root = useWzRoot("Hero", "wz-hero", props);
  const id = useHeadingId("hero");
  const { title, subtitle, eyebrow, primary, secondary, image, variant = "split", tone = "default" } = props;
  const text = (centered: boolean, rule = false) => (
    <div className={cx(centered && s.centered)}>
      {rule && <span className={s.rule} aria-hidden="true" />}
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
        {hasPicture(image) && (
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

  if (variant === "minimal")
    return (
      <Section
        root={root}
        anchor={props.anchor}
        tone={tone}
        labelledBy={id}
        className={cx(s.heroMinimal, props.className)}
      >
        {text(false, true)}
      </Section>
    );

  if (variant === "collage") {
    const pics = [image, ...(props.images ?? [])].filter(hasPicture).slice(0, 3);
    const slots = pics.length ? pics : [undefined, undefined, undefined];
    return (
      <Section root={root} anchor={props.anchor} tone={tone} labelledBy={id} className={props.className}>
        <div className={s.heroSplit}>
          {text(false)}
          <div className={s.collage}>
            {slots.map((p, i) => (
              <Media
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots of the collage
                key={i}
                image={p}
                ratio={i === 0 ? "3/4" : "1/1"}
                testId="wz-hero-image"
                priority={i === 0}
                sizes="(max-width: 640px) 100vw, 30vw"
              />
            ))}
          </div>
        </div>
      </Section>
    );
  }

  const media =
    variant === "centered" && !hasPicture(image) ? null : (
      <div className={s.heroMedia}>
        <Media image={image} ratio="4/3" testId="wz-hero-image" priority />
      </div>
    );
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
