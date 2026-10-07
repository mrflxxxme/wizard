// Testimonials (ui-kit.yaml#components.Testimonials, B2-35): reviews as the owner gives them (nothing is invented) —
// a grid of quotes, one large quote, or a row swiped by hand (carousel, no autoplay).
import type { ReactNode } from "react";
import { cx, useWzRoot } from "../../data/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./Blocks.module.css";
import { Carousel } from "./parts.js";
import { BlockHead, Section, useHeadingId } from "./Section.js";
import type { TestimonialItem, TestimonialsProps } from "./types.js";

function Cite(props: { item: TestimonialItem }): ReactNode {
  const { author, source } = props.item;
  if (!author && !source) return null;
  return (
    <footer className={s.cite}>
      {author && <strong>{author}</strong>}
      {author && source && " · "}
      {source}
    </footer>
  );
}

export function Testimonials(props: TestimonialsProps): ReactNode {
  const root = useWzRoot("Testimonials", "wz-testimonials", props);
  const id = useHeadingId("testimonials");
  const variant = props.variant ?? "cards";
  const card = (it: TestimonialItem) => (
    <blockquote className={cx(s.quoteCard, s.surface)}>
      <span className={s.quoteMark} aria-hidden="true">
        «
      </span>
      <p className={s.quoteText}>{it.text}</p>
      <Cite item={it} />
    </blockquote>
  );
  const key = (it: TestimonialItem, i: number) => `${i}:${it.text.slice(0, 24)}`;
  let body: ReactNode;
  if (variant === "quote") {
    const first = props.items[0];
    body = first ? (
      <blockquote className={s.bigQuote} data-testid="wz-testimonials-item">
        <p className={s.quoteText}>{`«${first.text}»`}</p>
        <Cite item={first} />
      </blockquote>
    ) : null;
  } else if (variant === "carousel")
    body = (
      <Carousel label={props.title ?? ru.blocks.testimonials} testId="wz-testimonials-track">
        {props.items.map((it, i) => (
          <li key={key(it, i)} data-testid="wz-testimonials-item">
            {card(it)}
          </li>
        ))}
      </Carousel>
    );
  else
    body = (
      <ul className={cx(s.grid, s.cols3)}>
        {props.items.map((it, i) => (
          <li key={key(it, i)} data-testid="wz-testimonials-item">
            {card(it)}
          </li>
        ))}
      </ul>
    );
  return (
    <Section root={root} anchor={props.anchor} tone={props.tone} labelledBy={id} className={props.className}>
      {props.title ? (
        <BlockHead id={id} title={props.title} centered={variant === "quote"} />
      ) : (
        <h2 id={id} className={s.srOnly}>
          {ru.blocks.testimonials}
        </h2>
      )}
      {body}
    </Section>
  );
}
