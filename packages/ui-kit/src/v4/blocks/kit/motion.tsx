// Motion of the blocks (D80 (4)): light reveal and micro-motion on desktop; on phones (< 768 px) and under
// prefers-reduced-motion every block stays a static frame. The first render is static too, so the server HTML and
// the LCP never wait for an animation.
import { domAnimation, LazyMotion, m } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

/** Narrowest viewport that gets motion: below it the static fallback is shown. */
export const MOTION_MIN_WIDTH = 768;
const QUERY = `(min-width: ${MOTION_MIN_WIDTH}px) and (prefers-reduced-motion: no-preference)`;

/** True while the block must stay static: server render, first paint, a phone or reduced motion. */
export function useStill(): boolean {
  const [still, setStill] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const sync = () => setStill(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return still;
}

/** Fades a child in once when it scrolls into view; static when `useStill` says so. */
export function Reveal({
  children,
  className,
  delay = 0,
  still,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  still: boolean;
}) {
  if (still) return <div className={className}>{children}</div>;
  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className={className}
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-10% 0px" }}
        transition={{ duration: 0.6, delay, ease: [0.23, 1, 0.32, 1] }}
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}
