// Gallery (ui-kit.yaml#components.Gallery, B2-35): pictures of work or the place — even tiles, tiles of different
// heights (masonry) or a row swiped by hand (carousel, no autoplay). Without a picture a tile shows the theme graphic.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import type { ImageRatio } from "../media/Image.js";
import s from "./Blocks.module.css";
import { Carousel, Media } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { GalleryItem, GalleryProps } from "./types.js";

/** Masonry rhythm: the ratios repeat so tiles differ in height without random numbers. */
const MASONRY: readonly ImageRatio[] = ["3/4", "1/1", "4/3", "1/1", "3/4", "4/3"];

export function Gallery(props: GalleryProps): ReactNode {
  const root = useWzRoot("Gallery", "wz-gallery", props);
  const id = useHeadingId("gallery");
  const variant = props.variant ?? "grid";
  const figure = (it: GalleryItem, ratio: ImageRatio) => (
    <figure className={s.figure}>
      <Media
        image={it.image}
        ratio={ratio}
        testId="wz-gallery-image"
        sizes="(max-width: 640px) 100vw, 33vw"
      />
      {it.caption && <figcaption className={s.caption}>{it.caption}</figcaption>}
    </figure>
  );
  const key = (it: GalleryItem, i: number) => `${i}:${it.caption ?? ""}`;
  let body: ReactNode;
  if (variant === "carousel")
    body = (
      <Carousel label={props.title ?? ru.blocks.gallery} testId="wz-gallery-track">
        {props.items.map((it, i) => (
          <li key={key(it, i)} data-testid="wz-gallery-item">
            {figure(it, "4/3")}
          </li>
        ))}
      </Carousel>
    );
  else
    body = (
      <ul className={cx(variant === "masonry" ? s.masonry : s.galleryGrid)}>
        {props.items.map((it, i) => (
          <li key={key(it, i)} data-testid="wz-gallery-item">
            {figure(it, variant === "masonry" ? (MASONRY[i % MASONRY.length] as ImageRatio) : "4/3")}
          </li>
        ))}
      </ul>
    );
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      {props.title ? (
        <BlockHead id={id} title={props.title} intro={props.intro} />
      ) : (
        <h2 id={id} className={s.srOnly}>
          {ru.blocks.gallery}
        </h2>
      )}
      {body}
    </Section>
  );
}
