// Features (ui-kit.yaml#components.Features, M2-43): advantages or services — points, cards with pictures, or rows of
// picture and text in turn.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { FeatureItem, FeaturesProps } from "./types.js";

const COLS = { 2: s.cols2, 3: s.cols3, 4: s.cols4 } as const;
const hasImage = (i: FeatureItem) => !!i.image && !!(i.image.fileId || i.image.src);

export function Features(props: FeaturesProps): ReactNode {
  const root = useWzRoot("Features", "wz-features", props);
  const id = useHeadingId("features");
  const { items, variant = "grid", columns = 3 } = props;
  let body: ReactNode;
  if (variant === "alternating") {
    body = (
      <ul className={s.rows}>
        {items.map((it) => (
          <li key={it.title} className={s.row} data-testid="wz-features-item">
            {hasImage(it) && it.image && (
              <div className={s.rowMedia}>
                <ImageImpl root={part("wz-features-image")} {...it.image} ratio="4/3" />
              </div>
            )}
            <div>
              <h3 className={s.h3}>{it.title}</h3>
              {it.text && <p className={s.text}>{it.text}</p>}
            </div>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={cx(s.grid, COLS[columns])}>
        {items.map((it) =>
          variant === "cards" ? (
            <li key={it.title} className={s.card} data-testid="wz-features-item">
              {hasImage(it) && it.image && (
                <ImageImpl
                  root={part("wz-features-image")}
                  {...it.image}
                  ratio="3/2"
                  rounded={false}
                  sizes="(max-width: 640px) 100vw, 400px"
                />
              )}
              <div className={s.cardBody}>
                <h3 className={s.h3}>{it.title}</h3>
                {it.text && <p className={s.text}>{it.text}</p>}
              </div>
            </li>
          ) : (
            <li key={it.title} className={s.point} data-testid="wz-features-item">
              <h3 className={s.h3}>{it.title}</h3>
              {it.text && <p className={s.text}>{it.text}</p>}
            </li>
          ),
        )}
      </ul>
    );
  }
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      <BlockHead id={id} title={props.title} intro={props.intro} />
      {body}
    </Section>
  );
}
