// The signature effect of a bar site plays only on a wide screen without reduced motion (D80 (4)): on 390 px and
// with prefers-reduced-motion the section renders its final frame.
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

/** True when the effect must show its static frame (reduced motion, narrow screen, or before hydration). */
export function useStill(): boolean {
  const reduce = useReducedMotion();
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(min-width: 64rem)");
    const on = () => setWide(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduce === true || !wide;
}

/** A photo slot: the build fills `src` (stock copy) and `credit` (author and stock, D61). */
export type Photo = { src: string; alt: string; credit: string };

/** Russian rouble price with a thin space: 1400 → «1 400 ₽». */
export const rub = (n: number): string => `${n.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽`;
