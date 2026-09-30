// ItemCard (ui-kit.yaml#components.ItemCard): price, remaining quota, option chips and CTA.
import { type ReactNode, useState } from "react";
import { cx, useWzRoot } from "../data/context.js";
import { formatDelta, formatMoney, pluralRu } from "../format.js";
import { ru } from "../i18n/ru.js";
import { BadgeImpl } from "./Badge.js";
import { ButtonImpl } from "./Button.js";
import styles from "./ItemCard.module.css";
import { part, type RootAttrs } from "./root.js";
import type { ItemCardProps, OptionGroup, Selection } from "./types.js";

export function ItemCard(props: ItemCardProps): ReactNode {
  return <ItemCardImpl {...props} root={useWzRoot("ItemCard", "wz-itemcard", props)} />;
}

/** Next selection after toggling `choice` in `group` (single: exactly one; multi: set toggle). */
export function toggleChoice(sel: Selection, group: OptionGroup, choice: string): Selection {
  const cur = sel[group.id] ?? [];
  if (group.kind === "single") return { ...sel, [group.id]: [choice] };
  return { ...sel, [group.id]: cur.includes(choice) ? cur.filter((c) => c !== choice) : [...cur, choice] };
}

export function ItemCardImpl(props: ItemCardProps & { root: RootAttrs }): ReactNode {
  const { root, title, description, image, price, priceText, remaining, badge, optionGroups = [] } = props;
  const [own, setOwn] = useState<Selection>({});
  const selection = props.selection ?? own;
  const setSelection = (s: Selection) => {
    if (props.selection === undefined) setOwn(s);
    props.onSelectionChange?.(s);
  };
  const low = props.lowThreshold ?? 20;
  const soldOut = remaining === 0;
  const deltas = optionGroups.reduce(
    (sum, g) =>
      sum +
      g.choices.filter((c) => selection[g.id]?.includes(c.id)).reduce((s, c) => s + (c.priceDelta ?? 0), 0),
    0,
  );
  const shownTotal = props.total ?? (typeof price === "number" && deltas > 0 ? price + deltas : undefined);

  return (
    <article {...root} className={cx(styles.card, soldOut && styles.soldOut, props.className)}>
      {image && <img className={styles.image} src={image} alt="" loading="lazy" />}
      <div className={styles.body}>
        <div className={styles.head}>
          <h3 className={styles.title}>{title}</h3>
          {badge && (
            <BadgeImpl root={part("wz-itemcard-badge")} tone={badge.tone}>
              {badge.text}
            </BadgeImpl>
          )}
        </div>
        {description && <p className={styles.description}>{description}</p>}
        <div className={styles.meta}>
          <span className={styles.price} data-testid="wz-itemcard-price">
            {typeof price === "number" ? formatMoney(price) : (priceText ?? "")}
          </span>
          {typeof remaining === "number" && (soldOut || remaining <= low) && (
            <span data-testid="wz-itemcard-remaining">
              <BadgeImpl root={part("wz-itemcard-remaining-badge")} tone={soldOut ? "bad" : "warn"}>
                {soldOut
                  ? ru.itemCard.soldOut
                  : ru.itemCard.left(remaining, pluralRu(remaining, ru.itemCard.places))}
              </BadgeImpl>
            </span>
          )}
        </div>
        {optionGroups.map((g) => {
          const labelId = `${root["data-wz-id"] ?? root["data-testid"]}-${props.id}-${g.id}`;
          return (
            <div key={g.id} className={styles.group}>
              <span id={labelId} className={styles.groupLabel}>
                {g.label}
              </span>
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is radiogroup or group (dynamic) */}
              <div
                className={styles.chips}
                role={g.kind === "single" ? "radiogroup" : "group"}
                aria-labelledby={labelId}
                aria-required={g.required || undefined}
              >
                {g.choices.map((c) => {
                  const on = selection[g.id]?.includes(c.id) ?? false;
                  return (
                    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: chips are role=radio|checkbox (dynamic)
                    <button
                      key={c.id}
                      type="button"
                      role={g.kind === "single" ? "radio" : "checkbox"}
                      aria-checked={on}
                      disabled={c.disabled || soldOut}
                      className={cx(styles.chip, on && styles.chipOn)}
                      data-testid={`wz-itemcard-option-${g.id}-${c.id}`}
                      onClick={() => setSelection(toggleChoice(selection, g, c.id))}
                    >
                      <span>{c.label}</span>
                      {c.priceDelta ? (
                        <span className={styles.delta}>{formatDelta(c.priceDelta)}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {shownTotal !== undefined && (
          <p className={styles.total}>
            {ru.itemCard.total}: <strong>{formatMoney(shownTotal)}</strong>
          </p>
        )}
        <ButtonImpl
          root={part("wz-itemcard-cta")}
          variant="primary"
          className={styles.cta}
          disabled={props.disabled || soldOut}
          onClick={props.onCta}
        >
          {soldOut ? ru.itemCard.soldOut : (props.ctaLabel ?? ru.itemCard.cta)}
        </ButtonImpl>
      </div>
    </article>
  );
}
