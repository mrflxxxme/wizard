// Field validation shared by RecordForm (client) and the memory DataSource (server semantics,
// runtime.yaml#data_api.writes). Messages are Russian; null when the value is valid.
import type { Field } from "@wizard/appspec";
import { ru } from "../i18n/ru.js";
import type { Rec } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+7\d{10}$/;
const URL_RE = /^https?:\/\/\S+$/;

/** Server-side field validation (runtime.yaml#data_api.writes); null when valid. */
export function fieldProblem(f: Field, v: unknown, db?: Map<string, Rec[]>): string | null {
  switch (f.type) {
    case "string":
    case "text":
      if (typeof v !== "string") return ru.field.text;
      if (f.maxLength && v.length > f.maxLength) return ru.field.maxLength(f.maxLength);
      return null;
    case "int":
    case "decimal":
    case "money":
      if (typeof v !== "number" || Number.isNaN(v)) return ru.field.number;
      if (f.type === "int" && !Number.isInteger(v)) return ru.field.integer;
      if (f.min !== undefined && v < f.min) return ru.field.min(f.min);
      if (f.max !== undefined && v > f.max) return ru.field.max(f.max);
      return null;
    case "bool":
      return typeof v === "boolean" ? null : ru.field.bool;
    case "enum":
      return f.enum?.some((o) => o.value === v) ? null : ru.field.enumValue;
    case "email":
      return typeof v === "string" && EMAIL_RE.test(v) ? null : ru.field.email;
    case "phone":
      return typeof v === "string" && PHONE_RE.test(v) ? null : ru.field.phone;
    case "url":
      return typeof v === "string" && URL_RE.test(v) ? null : ru.field.url;
    case "ref":
      if (!db || !f.ref) return null;
      if (f.ref.entity === "users") return null;
      return (db.get(f.ref.entity) ?? []).some((r) => r.id === v) ? null : ru.field.refMissing;
    default:
      return null;
  }
}
