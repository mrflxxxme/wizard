// Shared pieces of the library blocks: the photo slot, the rouble price, the still switch of motion (D80 (4)) and the
// focus ring every interactive element carries.
import { useEffect, useState } from "react";

/** A photo slot: the build fills `src` (stock copy) and `credit` (author and stock, D61). */
export type Photo = { src: string; alt: string; credit: string };

/** Russian rouble price with a thin space: 1400 → «1 400 ₽». */
export const rub = (n: number): string => `${n.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽`;

/** True when motion must show its final frame: reduced motion or a screen narrower than 64rem. */
export const stillFrame = (o: { reducedMotion: boolean; wide: boolean }): boolean =>
  o.reducedMotion || !o.wide;

/** True when the effect must show its static frame (reduced motion, narrow screen, or before hydration). */
export function useStill(): boolean {
  const [still, setStill] = useState(true);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 64rem)");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setStill(stillFrame({ reducedMotion: reduce.matches, wide: wide.matches }));
    on();
    wide.addEventListener?.("change", on);
    reduce.addEventListener?.("change", on);
    return () => {
      wide.removeEventListener?.("change", on);
      reduce.removeEventListener?.("change", on);
    };
  }, []);
  return still;
}

export const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A cover photo filling its frame; `filter` applies the direction's image treatment. */
export function Img({ photo, className, filter }: { photo: Photo; className?: string; filter?: boolean }) {
  return (
    <img
      src={photo.src}
      alt={photo.alt}
      decoding="async"
      className={`size-full object-cover${filter ? " [filter:var(--ds-image-filter)]" : ""} ${className ?? ""}`}
    />
  );
}

/** «Фото: автор / Pexels, …» line of the footer. */
export function Credit({ list, className }: { list: readonly string[]; className?: string }) {
  return <p className={`text-sm ${className ?? ""}`}>Фото: {list.join(", ")}</p>;
}
