// Read-only rendering of a field value (DataTable cells, RecordCard details): Intl formats, enum badges, ref captions.
import type { Field } from "@wizard/appspec";
import type { ReactNode } from "react";
import { useDataSource, useRoleSpec } from "../data/context.js";
import { can, titleField } from "../data/roleSpec.js";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../format.js";
import { ru } from "../i18n/ru.js";
import { BadgeImpl } from "./Badge.js";
import fieldValueStyles from "./FieldValue.module.css";
import { ImageImpl } from "./media/Image.js";
import { part } from "./root.js";

const thumb = fieldValueStyles.thumb;

const EMPTY = "—";

export function FieldValue({ field, value }: { field: Field | undefined; value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (!field) return String(value);
  switch (field.type) {
    case "enum":
      return (
        <BadgeImpl root={part("wz-enum")} tone="neutral">
          {field.enum?.find((o) => o.value === value)?.label ?? String(value)}
        </BadgeImpl>
      );
    case "money":
      return typeof value === "number" ? formatMoney(value) : String(value);
    case "int":
    case "decimal":
      return typeof value === "number" ? formatNumber(value) : String(value);
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "bool":
      return value ? ru.field.yes : ru.field.no;
    case "ref":
      return field.ref ? <RefCaption entity={field.ref.entity} id={String(value)} /> : String(value);
    case "file":
      return <a href={`/api/files/${encodeURIComponent(String(value))}`}>{ru.field.download}</a>;
    case "image":
      return (
        <span className={thumb}>
          <ImageImpl
            root={part(`wz-image--${field.name}`)}
            fileId={String(value)}
            alt={field.label}
            ratio="4/3"
            sizes="160px"
          />
        </span>
      );
    case "qr_token":
      return "•••";
    case "json":
      return JSON.stringify(value).slice(0, 80);
    default:
      return String(value);
  }
}

/** Caption of a referenced record: its first string field (only when the role may read the target). */
function RefCaption({ entity, id }: { entity: string; id: string }): ReactNode {
  const spec = useRoleSpec();
  if (!can(spec, "read", entity)) return EMPTY;
  return <RefCaptionLoaded entity={entity} id={id} field={titleField(spec, entity)} />;
}

function RefCaptionLoaded({ entity, id, field }: { entity: string; id: string; field: string | undefined }) {
  const r = useDataSource().useRecord<Record<string, unknown>>(entity, id);
  if (!r.data) return r.error ? EMPTY : ru.states.loading;
  return field ? String(r.data[field] ?? EMPTY) : id;
}
