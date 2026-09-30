import type { ReactNode } from "react";
import { cx, useWzRoot, type WzBase } from "../data/context.js";
import styles from "./Badge.module.css";
import type { RootAttrs } from "./root.js";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "bad";

export interface BadgeProps extends WzBase {
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge(props: BadgeProps): ReactNode {
  return <BadgeImpl {...props} root={useWzRoot("Badge", "wz-badge", props)} />;
}

export function BadgeImpl({ root, tone = "neutral", children, className }: BadgeProps & { root: RootAttrs }) {
  return (
    <span {...root} className={cx(styles.badge, styles[tone], className)} data-tone={tone}>
      {children}
    </span>
  );
}
