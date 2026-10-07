// Features (ui-kit.yaml#components.Features, M2-43, B2-35): advantages or services — points, cards with pictures, rows
// of picture and text in turn (the theme graphic without a picture), or points with icons.
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ImageImpl } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import { BlockIcon, ICON_CYCLE, Placeholder } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { BlockIconName, FeatureItem, FeaturesProps } from "./types.js";

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
            <div className={s.rowMedia}>
              {hasImage(it) && it.image ? (
                <ImageImpl root={part("wz-features-image")} {...it.image} ratio="4/3" />
              ) : (
                <Placeholder ratio="4/3" />
              )}
            </div>
            <div>
              <h3 className={s.h3}>{it.title}</h3>
              {it.text && <p className={s.text}>{it.text}</p>}
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (variant === "icons") {
    body = (
      <ul className={cx(s.grid, COLS[columns])}>
        {items.map((it, i) => (
          <li key={it.title} className={s.iconItem} data-testid="wz-features-item">
            <span className={s.iconBadge}>
              <BlockIcon name={it.icon ?? (ICON_CYCLE[i % ICON_CYCLE.length] as BlockIconName)} />
            </span>
            <h3 className={s.h3}>{it.title}</h3>
            {it.text && <p className={s.text}>{it.text}</p>}
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={cx(s.grid, COLS[columns])}>
        {items.map((it) =>
          variant === "cards" ? (
            <li key={it.title} className={cx(s.card, s.surface)} data-testid="wz-features-item">
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
