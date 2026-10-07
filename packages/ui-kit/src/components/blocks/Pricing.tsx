// Pricing (ui-kit.yaml#components.Pricing, B2-35): prices from the system's own data (catalog services or package
// tariffs over DataSource.useList, the owner edits them in the cabinet) — tariff cards, a price list in rows, or a
// compact «name … price» list. Nothing is typed into the page: no prices are invented.
import type { ReactNode } from "react";
import { cx, useDataSource, useWzRoot } from "../../data/context.js";
import type { Rec } from "../../data/types.js";
import { formatMoney } from "../../format.js";
import { ru } from "../../i18n/ru.js";
import { DataState } from "../States.js";
import s from "./Blocks.module.css";
import { Actions, BlockHead, Section, useHeadingId } from "./Section.js";
import type { PriceDetail, PricingProps } from "./types.js";

const MAX_ROWS = 48;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const price = (v: unknown): string => (typeof v === "number" ? formatMoney(v) : ru.blocks.priceOnRequest);
const details = (r: Rec, list: readonly PriceDetail[]): string =>
  list
    .flatMap((d) => {
      const v = r[d.field];
      return v === null || v === undefined || v === ""
        ? []
        : [`${String(v)}${d.suffix ? ` ${d.suffix}` : ""}`];
    })
    .join(" · ");

export function Pricing(props: PricingProps): ReactNode {
  const root = useWzRoot("Pricing", "wz-pricing", props);
  const id = useHeadingId("pricing");
  const ds = useDataSource();
  const variant = props.variant ?? "cards";
  const nameField = props.nameField ?? "name";
  const priceField = props.priceField ?? "price";
  const list = ds.useList<Rec>(props.entity, { ...props.query, page: 1, pageSize: MAX_ROWS });
  const rows = list.data?.items ?? [];
  const d = props.details ?? [];
  const name = (r: Rec) => text(r[nameField]) ?? "—";
  const desc = (r: Rec) => (props.descriptionField ? text(r[props.descriptionField]) : undefined);

  let body: ReactNode = (
    <DataState
      result={list}
      empty={list.data?.items.length === 0}
      emptyText={props.emptyText ?? ru.blocks.priceEmpty}
    />
  );
  if (rows.length > 0 && !list.error) {
    if (variant === "table")
      body = (
        <table className={s.priceTable}>
          <thead>
            <tr>
              <th scope="col">{ru.blocks.priceName}</th>
              {d.length > 0 && <th scope="col">{ru.blocks.details}</th>}
              <th scope="col" className={s.num}>
                {ru.blocks.price}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="wz-pricing-item">
                <td>
                  <strong>{name(r)}</strong>
                  {desc(r) && <span className={cx(s.priceMeta, s.blockLine)}>{desc(r)}</span>}
                </td>
                {d.length > 0 && <td className={s.meta}>{details(r, d)}</td>}
                <td className={s.num}>{price(r[priceField])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    else if (variant === "compact")
      body = (
        <ul className={s.priceCompact}>
          {rows.map((r) => (
            <li key={r.id} className={s.priceLine} data-testid="wz-pricing-item">
              <span className={s.name}>
                {name(r)}
                {d.length > 0 && details(r, d) && (
                  <span className={s.priceMeta}>{` · ${details(r, d)}`}</span>
                )}
              </span>
              <span className={s.leader} aria-hidden="true" />
              <span className={s.num}>{price(r[priceField])}</span>
            </li>
          ))}
        </ul>
      );
    else
      body = (
        <ul className={s.priceCards}>
          {rows.map((r) => (
            <li key={r.id} className={cx(s.priceCard, s.surface)} data-testid="wz-pricing-item">
              <h3 className={s.h3}>{name(r)}</h3>
              {d.length > 0 && details(r, d) && <span className={s.priceMeta}>{details(r, d)}</span>}
              <span className={s.priceValue}>{price(r[priceField])}</span>
              {desc(r) && <p className={s.text}>{desc(r)}</p>}
              {props.action && <Actions primary={props.action} testBase="wz-pricing" />}
            </li>
          ))}
        </ul>
      );
  }
  return (
    <Section
      root={root}
      anchor={props.anchor}
      tone={props.tone}
      labelledBy={id}
      className={props.className}
      narrow={variant === "compact"}
    >
      <BlockHead id={id} title={props.title} intro={props.intro} />
      {body}
      {props.note && <p className={s.note}>{props.note}</p>}
      {props.action && variant !== "cards" && rows.length > 0 && (
        <Actions primary={props.action} testBase="wz-pricing" />
      )}
    </Section>
  );
}
