// Shared parts of the landing blocks v2 (B2-35, internal): decorative icons, the theme graphic placeholder of a missing
// picture, a picture-or-placeholder slot, paragraphs of a plain text and a carousel row swiped by hand.
import { type ReactNode, useRef } from "react";
import { cx } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import { ImageImpl, type ImageRatio, type ImageSource } from "../media/Image.js";
import { part } from "../root.js";
import s from "./Blocks.module.css";
import type { BlockIconName } from "./types.js";

const ICON_PATHS: Record<BlockIconName, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2",
  shield: "M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z M9 12l2 2 4-4",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  leaf: "M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19l7-7",
  spark: "M12 3v5M12 16v5M3 12h5M16 12h5M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3",
  pin: "M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  phone:
    "M6.6 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.1 6.1l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z",
  chat: "M4.5 5.5h15v10h-9l-4.5 3.5v-3.5h-1.5z",
  calendar: "M5 6.5h14v13H5zM5 10.5h14M9 4v4M15 4v4",
  gift: "M4.5 9.5h15v3h-15zM6 12.5h12v7H6zM12 9.5v10M12 9.5c-1.5-3.5-5-3.5-5-1.5S9.5 9.5 12 9.5c2.5 0 5 0 5-1.5s-3.5-2-5 1.5",
};

/** Icon order when an item names none: the items still look different. */
export const ICON_CYCLE: readonly BlockIconName[] = [
  "check",
  "clock",
  "star",
  "shield",
  "heart",
  "spark",
  "leaf",
  "chat",
];

export function BlockIcon(props: { name: BlockIconName; className?: string }): ReactNode {
  return (
    <svg
      className={cx(s.icon, props.className)}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[props.name]} />
    </svg>
  );
}

const RATIO_CLASS: Partial<Record<ImageRatio, string | undefined>> = {
  "16/9": s.ph16x9,
  "4/3": s.ph4x3,
  "3/2": s.ph3x2,
  "1/1": s.ph1x1,
  "3/4": s.ph3x4,
};

/** Theme graphic in place of a missing picture (decorative: no alt, nothing for screen readers). */
export function Placeholder(props: { ratio?: ImageRatio; label?: string; className?: string }): ReactNode {
  return (
    <div
      className={cx(s.ph, RATIO_CLASS[props.ratio ?? "4/3"], props.className)}
      aria-hidden="true"
      data-testid="wz-placeholder"
    >
      {props.label && <span className={s.phLabel}>{props.label}</span>}
    </div>
  );
}

export const hasPicture = (img: ImageSource | undefined): img is ImageSource =>
  !!img && !!(img.fileId || img.src);

/** The picture when there is one, else the theme graphic of the same proportions. */
export function Media(props: {
  image?: ImageSource | undefined;
  ratio: ImageRatio;
  testId: string;
  sizes?: string;
  priority?: boolean;
  rounded?: boolean;
  label?: string;
  className?: string;
}): ReactNode {
  if (!hasPicture(props.image))
    return <Placeholder ratio={props.ratio} label={props.label} className={props.className} />;
  return (
    <div className={props.className}>
      <ImageImpl
        root={part(props.testId)}
        {...props.image}
        ratio={props.ratio}
        {...(props.sizes ? { sizes: props.sizes } : {})}
        {...(props.priority ? { priority: true } : {})}
        {...(props.rounded === false ? { rounded: false } : {})}
      />
    </div>
  );
}

/** Paragraphs of a plain text: an empty line separates them. */
export function Paragraphs(props: { text: string; className?: string | undefined }): ReactNode {
  const parts = props.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {parts.map((p) => (
        <p key={p} className={props.className}>
          {p}
        </p>
      ))}
    </>
  );
}

/**
 * A row of cards swiped by hand (scroll-snap) with «Назад»/«Вперёд» buttons; no autoplay. The row scrolls inside its
 * own box, so the page never scrolls sideways.
 */
export function Carousel(props: { label: string; children: ReactNode; testId: string }): ReactNode {
  const track = useRef<HTMLUListElement>(null);
  const move = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  };
  return (
    <div className={s.carousel}>
      <ul ref={track} className={s.track} aria-label={props.label} data-testid={props.testId}>
        {props.children}
      </ul>
      <div className={s.carouselNav}>
        <button type="button" className={s.navButton} onClick={() => move(-1)} aria-label={ru.blocks.prev}>
          <span aria-hidden="true">←</span>
        </button>
        <button type="button" className={s.navButton} onClick={() => move(1)} aria-label={ru.blocks.next}>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}

/** First letters of a name for a monogram («Анна Петрова» → «АП»). */
export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "");
  return letters.join("") || "•";
}
