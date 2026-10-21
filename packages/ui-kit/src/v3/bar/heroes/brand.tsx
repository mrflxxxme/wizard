// Brand marks of the two businesses (grill-11, round 2 (4)): plain SVG in currentColor, so a screen recolours them
// with a text token. Терехова: a scored loaf whose score is the letter Т with three wisps of steam. Бокс 14: the bay
// number as a floor stencil with a lift arrow.

/** Mark of Булочная Терехова: an oval loaf, the score drawn as «Т», steam above. */
export function TerekhovMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <path
        d="M22 14c-2-3 2-5 0-8M32 14c-2-3 2-5 0-8M42 14c-2-3 2-5 0-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <ellipse cx="32" cy="40" rx="27" ry="18" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M18 31h28M32 31v22" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

/** Logo lockup: the mark and the name in the display face. */
export function TerekhovLogo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display text-xl leading-none ${className ?? ""}`}>
      <TerekhovMark className="size-9" />
      <span>
        Булочная
        <br />
        Терехова
      </span>
    </span>
  );
}

/** Mark of Бокс 14: «14» stencilled in a square bay with an up arrow of the lift. */
export function Box14Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect
        x="3"
        y="3"
        width="58"
        height="58"
        rx="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeDasharray="12 5"
      />
      <path
        d="M17 22l5-4v28M37 18l-8 18h14M41 30v16"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="square"
      />
      <path d="M50 18v10M46 22l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

/** Logo lockup of the car service. */
export function Box14Logo({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-display text-lg font-bold leading-none ${className ?? ""}`}
    >
      <Box14Mark className="size-9 text-accent-text" />
      Бокс 14
    </span>
  );
}
