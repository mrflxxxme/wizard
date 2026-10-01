// RecordCard (ui-kit.yaml#components.RecordCard): details as a <dl> of visible fields plus permitted actions.
import type { ReactNode } from "react";
import { cx, useDataSource, useRoleSpec, useWzRoot } from "../data/context.js";
import { entityOf } from "../data/roleSpec.js";
import type { Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { BadgeImpl } from "./Badge.js";
import { FieldValue } from "./FieldValue.js";
import { RecordActions } from "./RecordActions.js";
import styles from "./RecordCard.module.css";
import { part } from "./root.js";
import { DataState } from "./States.js";
import type { RecordCardProps } from "./types.js";

export function RecordCard<T = Rec>(props: RecordCardProps<T>): ReactNode {
  const root = useWzRoot("RecordCard", "wz-recordcard", props);
  const spec = useRoleSpec();
  const rec = useDataSource().useRecord<T>(props.entity, props.id);
  const ent = entityOf(spec, props.entity);
  const visible = (ent?.fields ?? []).filter((f) => f.type !== "qr_token" && f.type !== "json");
  // Only fields visible to the role (RoleSpec has no hiddenFields) are rendered.
  const fields = props.fields ? props.fields.flatMap((n) => visible.filter((f) => f.name === n)) : visible;
  const row = rec.data;
  const title = row ? (typeof props.title === "function" ? props.title(row) : props.title) : undefined;
  // M3: record meta of the runtime — fields whose last write was an AI action (ui-kit.yaml#components.RecordCard).
  const meta = (row as Rec | undefined)?._aiFilled;
  const aiFilled = new Set(Array.isArray(meta) ? meta.filter((x): x is string => typeof x === "string") : []);

  return (
    <article {...root} className={cx(styles.card, props.className)} aria-busy={rec.isLoading || undefined}>
      {!row ? (
        <DataState result={rec} lines={4} />
      ) : (
        <>
          {title && <h2 className={styles.title}>{title}</h2>}
          <dl className={styles.list}>
            {fields.map((f) => (
              <div key={f.name} className={styles.item} data-testid={`wz-recordcard-field-${f.name}`}>
                <dt>{f.label}</dt>
                <dd>
                  <FieldValue field={f} value={(row as Rec)[f.name]} />
                  {aiFilled.has(f.name) && (
                    <BadgeImpl root={part(`wz-recordcard-ai-${f.name}`)} tone="accent" className={styles.ai}>
                      {ru.ai.filled}
                    </BadgeImpl>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <RecordActions
            entity={props.entity}
            row={row}
            actions={props.actions}
            testPrefix="wz-recordcard-action"
            onDone={rec.refetch}
            onDeleted={props.onDeleted}
          />
        </>
      )}
    </article>
  );
}
