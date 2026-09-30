// Field (ui-kit.yaml#components.Field, RecordForm.field_mapping) with a11y#labels.
import type { FieldType } from "@wizard/appspec";
import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import { cx, useWzRoot, type WzBase } from "../data/context.js";
import { formatPhoneInput, phoneDigits } from "../format.js";
import { ru } from "../i18n/ru.js";
import styles from "./Field.module.css";
import type { RootAttrs } from "./root.js";

export type { FieldType };

export interface FieldProps extends WzBase {
  name: string;
  label: string;
  type: FieldType;
  value: unknown;
  onChange(v: unknown): void;
  required?: boolean;
  error?: string;
  hint?: string;
  enumOptions?: { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
  disabled?: boolean;
  readOnly?: boolean;
  autoComplete?: string;
}

export function Field(props: FieldProps): ReactNode {
  const root = useWzRoot("Field", `wz-field-${props.name}`, props);
  return <FieldImpl {...props} root={root} idBase={root["data-wz-id"] ?? "field"} />;
}

const NUMERIC: ReadonlySet<FieldType> = new Set(["int", "decimal", "money"]);

function numText(v: unknown): string {
  return typeof v === "number" ? String(v).replace(".", ",") : typeof v === "string" ? v : "";
}

function parseNum(t: string): number | string | null {
  const s = t.replace(/\s/g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d*\.?\d*$/.test(s) && !s.endsWith(".") ? n : t;
}

/** ISO UTC → value of <input type=datetime-local> in the browser time zone. */
function toLocalInput(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function FieldImpl(props: FieldProps & { root: RootAttrs; idBase: string; children?: ReactNode }) {
  const { root, idBase, name, label, type, value, onChange, required, error, hint, enumOptions } = props;
  const id = `wz-${idBase}-${name}`.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const hintId = hint || props.readOnly ? `${id}-hint` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name,
    disabled: props.disabled,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": required || undefined,
  } as const;
  const [text, setText] = useState(() => numText(value));
  useEffect(() => {
    if (NUMERIC.has(type) && parseNum(text) !== (value ?? null)) setText(numText(value));
  }, [value, type, text]);

  const labelEl = (
    <span className={styles.labelRow}>
      <span className={styles.labelText}>{label}</span>
      {required && <span className={styles.required}>{ru.field.required}</span>}
    </span>
  );
  const hintText = props.readOnly ? [hint, ru.field.readOnly].filter(Boolean).join(" · ") : hint;
  const footer = (
    <>
      {hintText && (
        <span id={hintId} className={styles.hint}>
          {hintText}
        </span>
      )}
      {error && (
        <span id={errId} className={styles.error}>
          {error}
        </span>
      )}
    </>
  );

  const radios = type === "enum" && (enumOptions?.length ?? 0) <= 5;
  if (radios || type === "bool") {
    const bool = type === "bool";
    return (
      <div {...root} className={cx(styles.field, props.className)}>
        {bool ? (
          <label className={styles.check} htmlFor={id}>
            <input
              {...common}
              type="checkbox"
              checked={value === true}
              readOnly={props.readOnly}
              onChange={(e) => !props.readOnly && onChange(e.target.checked)}
            />
            {labelEl}
          </label>
        ) : (
          <fieldset
            className={styles.group}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            disabled={props.disabled}
          >
            <legend className={styles.legend}>{labelEl}</legend>
            <div className={styles.options} role="radiogroup" aria-required={required || undefined}>
              {(enumOptions ?? []).map((o) => (
                <label key={o.value} className={styles.check} htmlFor={`${id}-${o.value}`}>
                  <input
                    id={`${id}-${o.value}`}
                    type="radio"
                    name={id}
                    value={o.value}
                    checked={value === o.value}
                    readOnly={props.readOnly}
                    onChange={() => !props.readOnly && onChange(o.value)}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {footer}
      </div>
    );
  }

  let control: ReactNode;
  const str = typeof value === "string" ? value : value == null ? "" : String(value);
  const onText = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value);
  if (type === "enum" || type === "ref") {
    control = (
      <select
        {...common}
        className={styles.input}
        value={str}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        aria-readonly={props.readOnly || undefined}
      >
        <option value="">{ru.field.choose}</option>
        {(enumOptions ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (type === "text") {
    control = (
      <textarea
        {...common}
        className={cx(styles.input, styles.textarea)}
        value={str}
        rows={3}
        maxLength={props.maxLength}
        readOnly={props.readOnly}
        onChange={onText}
      />
    );
  } else if (NUMERIC.has(type)) {
    control = (
      <span className={styles.affix}>
        <input
          {...common}
          className={styles.input}
          type="text"
          inputMode={type === "int" ? "numeric" : "decimal"}
          value={text}
          readOnly={props.readOnly}
          autoComplete={props.autoComplete ?? "off"}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseNum(e.target.value));
          }}
        />
        {type === "money" && (
          <span className={styles.suffix} aria-hidden="true">
            ₽
          </span>
        )}
      </span>
    );
  } else if (type === "phone") {
    control = (
      <input
        {...common}
        className={styles.input}
        type="tel"
        inputMode="tel"
        placeholder="+7 (___) ___-__-__"
        autoComplete={props.autoComplete ?? "tel"}
        value={formatPhoneInput(str)}
        readOnly={props.readOnly}
        onChange={(e) => {
          const d = phoneDigits(e.target.value);
          onChange(d ? `+7${d}` : "");
        }}
      />
    );
  } else if (type === "datetime") {
    control = (
      <input
        {...common}
        className={styles.input}
        type="datetime-local"
        value={toLocalInput(value)}
        readOnly={props.readOnly}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
      />
    );
  } else {
    const htmlType = type === "email" ? "email" : type === "url" ? "url" : type === "date" ? "date" : "text";
    control = (
      <input
        {...common}
        className={styles.input}
        type={htmlType}
        value={str}
        maxLength={props.maxLength}
        readOnly={props.readOnly || type === "qr_token" || type === "json" || type === "file"}
        autoComplete={props.autoComplete}
        onChange={onText}
      />
    );
  }

  return (
    <div {...root} className={cx(styles.field, props.className)}>
      <label htmlFor={id} className={styles.label}>
        {labelEl}
      </label>
      {props.children}
      {control}
      {footer}
    </div>
  );
}
