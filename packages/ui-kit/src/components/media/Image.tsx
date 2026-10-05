// Image (ui-kit.yaml#components.Image, M2-47): a picture of an image field (fileId → WebP variants 480/960/1600 from the
// runtime, srcset + sizes) or a static picture of the bundle (src). Lazy by default, alt is required (decorative pictures
// say so explicitly), a placeholder box keeps the layout until the picture loads; no external hosts.
import { type ReactNode, useEffect, useState } from "react";
import { cx, useDataSource, useWzRoot, type WzBase } from "../../data/context.js";
import type { ImageWidth } from "../../data/types.js";
import { ru } from "../../i18n/ru.js";
import type { RootAttrs } from "../root.js";
import styles from "./Image.module.css";

export type ImageRatio = "16/9" | "4/3" | "3/2" | "1/1" | "3/4" | "21/9" | "auto";

/** Where a picture comes from: an image field value (fileId) or a bundled file (src). */
export interface ImageSource {
  fileId?: string | null;
  src?: string;
  /** Short description for screen readers; "" only with decorative. */
  alt: string;
  decorative?: boolean;
}

export interface ImageProps extends WzBase, ImageSource {
  /** Placeholder box proportions (default 16/9; auto — the picture's own). */
  ratio?: ImageRatio;
  fit?: "cover" | "contain";
  /** sizes for srcset (default: full width on phones, half on large screens). */
  sizes?: string;
  /** First screen: eager loading and high fetch priority. */
  priority?: boolean;
  rounded?: boolean;
}

export const IMAGE_WIDTHS: readonly ImageWidth[] = [480, 960, 1600];
const RATIO_CLASS: Record<ImageRatio, string | undefined> = {
  "16/9": styles.r16x9,
  "4/3": styles.r4x3,
  "3/2": styles.r3x2,
  "1/1": styles.r1x1,
  "3/4": styles.r3x4,
  "21/9": styles.r21x9,
  auto: undefined,
};

export function Image(props: ImageProps): ReactNode {
  return <ImageImpl {...props} root={useWzRoot("Image", "wz-image", props)} />;
}

export function ImageImpl(props: ImageProps & { root: RootAttrs }): ReactNode {
  const {
    root,
    fileId,
    src,
    alt,
    decorative = false,
    ratio = "16/9",
    fit = "cover",
    priority = false,
  } = props;
  const files = useDataSource().useFiles();
  const key = fileId ?? src ?? "";
  // Keyed by the picture: a new fileId shows the placeholder again; no reset effect (a cached picture may load first).
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const loaded = loadedKey === key;
  const failed = failedKey === key;
  const sizes = props.sizes ?? "(max-width: 640px) 100vw, (max-width: 1200px) 50vw, 600px";
  useEffect(() => {
    if (!decorative && !alt.trim() && typeof console !== "undefined") console.error(ru.image.missingAlt);
  }, [alt, decorative]);
  const has = !!(fileId || src) && !failed;
  const img = has ? (
    <img
      className={cx(styles.img, fit === "contain" && styles.contain, loaded && styles.loaded)}
      alt={decorative ? "" : alt}
      src={fileId ? files.imageSrc(fileId, 960) : src}
      srcSet={fileId ? IMAGE_WIDTHS.map((w) => `${files.imageSrc(fileId, w)} ${w}w`).join(", ") : undefined}
      sizes={fileId ? sizes : undefined}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      {...(priority ? { fetchPriority: "high" as const } : {})}
      onLoad={() => setLoadedKey(key)}
      onError={() => setFailedKey(key)}
      data-testid="wz-image-img"
    />
  ) : null;
  return (
    <div
      {...root}
      className={cx(
        styles.box,
        RATIO_CLASS[ratio],
        props.rounded !== false && styles.rounded,
        props.className,
      )}
      data-state={has ? (loaded ? "loaded" : "loading") : "empty"}
      {...(!has && !decorative ? { role: "img", "aria-label": alt } : {})}
      {...(!has && decorative ? { "aria-hidden": true } : {})}
    >
      {img}
    </div>
  );
}
