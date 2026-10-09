// Lead form «centered»: a tinted band with one narrow column on its axis — the heading and a line of text centred, the
// fields one under another, the consent and a full-width action, a direct channel under it. The logic is the module's:
// useLeadForm (C4) gives the fields, validation, server errors, the personal data consent (G2-PII-04) and «sent».
// Composition after shadcn/ui «Card» forms (MIT, © shadcn), rewritten on the design system tokens.
import { type FormModel, useContent, useLeadForm } from "@wizard/ui-kit/v3/headless";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

type Field = FormModel["fields"][number];
type Link = { label: string; href: string };

export type FormCenteredProps = {
  /** Entity the form creates (publicFront.actions[].entity; default lead). */
  entity?: string;
  /** Field names in order (default: what the role may fill). */
  fields?: string[];
  title: string;
  text?: string;
  /** The action: a verb and an object (catalog K09). */
  submit: string;
  sent: { title: string; text?: string };
  /** The action of the «sent» state. */
  again?: string;
  note?: string;
  /** A direct channel instead of the form. */
  contact?: Link;
};

const controlClass =
  "block min-h-12 w-full min-w-0 rounded-control border border-border bg-background px-4 py-2.5 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[invalid=true]:border-2 aria-[invalid=true]:border-foreground";
const primaryClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const secondaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-inherit transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Autocomplete by the kind of personal data (catalog A09). */
const AUTOCOMPLETE: Readonly<Record<string, string>> = {
  fio: "name",
  phone: "tel",
  email: "email",
  address: "street-address",
  birthdate: "bday",
};
const NUMERIC = new Set(["int", "decimal", "money"]);

/** Ten digits of a Russian number typed in any form: 8…, +7…, spaces, brackets. */
function phoneDigits(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length > 10 && (d.startsWith("7") || d.startsWith("8"))) d = d.slice(1);
  else if (d.length <= 10 && v.trim().startsWith("+7")) d = d.slice(1);
  return d.slice(0, 10);
}

/** The typed number as «+7 (900) 123-45-67». */
function phoneMask(v: string): string {
  const p = phoneDigits(v);
  if (!p) return "";
  let out = `+7 (${p.slice(0, 3)}`;
  if (p.length >= 3) out += ")";
  if (p.length > 3) out += ` ${p.slice(3, 6)}`;
  if (p.length > 6) out += `-${p.slice(6, 8)}`;
  if (p.length > 8) out += `-${p.slice(8, 10)}`;
  return out;
}

/** ISO time → the value of <input type=datetime-local> in the visitor's time zone. */
function localInput(v: unknown): string {
  const d = typeof v === "string" && v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The error of a field or of the consent, under it and linked by aria-describedby (catalog A03). */
function Problem({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 flex items-start gap-2 text-small font-bold">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className="mt-0.5 size-4 shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5v4.5M8 11.25v.25" strokeLinecap="round" />
      </svg>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A checkbox with a 44 px target (catalog A01): the native input, transparent, over the drawn box. */
function Check(props: {
  id: string;
  checked: boolean;
  onChange(v: boolean): void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { id, checked, onChange, invalid, describedBy } = props;
  return (
    <span className="relative -ml-2.5 flex size-11 shrink-0 items-center justify-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className="absolute inset-0 m-0 size-11 cursor-pointer appearance-none rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none flex size-6 items-center justify-center rounded-sm border-2 ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground bg-background"
        }`}
      >
        {checked ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="size-4"
          >
            <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </span>
  );
}

/** Options of a reference field: what the role may read of the referenced list, by its name. */
function RefOptions({ entity }: { entity: string }) {
  const list = useContent(entity, { pageSize: 96 });
  return (
    <>
      {list.items.map((r) => (
        <option key={r.id} value={r.id}>
          {String(r.name ?? r.title ?? r.id)}
        </option>
      ))}
    </>
  );
}

/** One field: the label always above it, the control by the field type, the error under it. */
function FieldRow({
  field,
  form,
  uid,
  className,
}: {
  field: Field;
  form: FormModel;
  uid: string;
  className?: string;
}) {
  const id = `${uid}-${field.name}`;
  const errId = `${id}-error`;
  const error = form.errors[field.name];
  const value = form.values[field.name];
  const set = (v: unknown) => form.setValue(field.name, v);
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const aria = {
    id,
    name: field.name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errId : undefined,
    "aria-required": field.required ? true : undefined,
  } as const;
  const label = (
    <>
      {field.label}
      {field.required ? <span className="font-normal text-muted-foreground"> · обязательно</span> : null}
    </>
  );
  if (field.type === "bool")
    return (
      <div className={className}>
        <div className="flex items-start gap-2">
          <Check
            id={id}
            checked={value === true}
            onChange={set}
            invalid={!!error}
            describedBy={error ? errId : undefined}
          />
          <label htmlFor={id} className="min-w-0 pt-2.5 text-body">
            {label}
          </label>
        </div>
        {error ? <Problem id={errId}>{error}</Problem> : null}
      </div>
    );
  let control: ReactNode;
  if (field.type === "text")
    control = (
      <textarea
        {...aria}
        rows={4}
        maxLength={field.maxLength}
        value={text}
        onChange={(e) => set(e.target.value)}
        className={`${controlClass} min-h-28 resize-y`}
      />
    );
  else if (field.type === "enum" || field.type === "ref")
    control = (
      <span className="relative block">
        <select
          {...aria}
          value={text}
          onChange={(e) => set(e.target.value || null)}
          className={`${controlClass} appearance-none pr-11`}
        >
          <option value="">Выберите…</option>
          {field.type === "enum" ? (
            (field.enum ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ) : field.ref ? (
            <RefOptions entity={field.ref.entity} />
          ) : null}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  else if (field.type === "phone")
    control = (
      <input
        {...aria}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="+7 (900) 000-00-00"
        value={phoneMask(text)}
        onChange={(e) => {
          const d = phoneDigits(e.target.value);
          set(d ? `+7${d}` : "");
        }}
        className={controlClass}
      />
    );
  else if (NUMERIC.has(field.type))
    control = (
      <input
        {...aria}
        type="text"
        inputMode={field.type === "int" ? "numeric" : "decimal"}
        value={text}
        onChange={(e) => {
          const raw = e.target.value.trim();
          set(raw === "" ? null : /^-?\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(",", ".")) : raw);
        }}
        className={controlClass}
      />
    );
  else if (field.type === "datetime")
    control = (
      <input
        {...aria}
        type="datetime-local"
        value={localInput(value)}
        onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : null)}
        className={controlClass}
      />
    );
  else
    control = (
      <input
        {...aria}
        type={
          field.type === "email"
            ? "email"
            : field.type === "url"
              ? "url"
              : field.type === "date"
                ? "date"
                : "text"
        }
        inputMode={field.type === "email" ? "email" : field.type === "url" ? "url" : undefined}
        autoComplete={
          (field.piiKind && AUTOCOMPLETE[field.piiKind]) || (field.type === "email" ? "email" : undefined)
        }
        maxLength={field.maxLength}
        value={text}
        onChange={(e) => set(e.target.value)}
        className={controlClass}
      />
    );
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <label htmlFor={id} className="block text-small font-bold">
        {label}
      </label>
      <div className="mt-2">{control}</div>
      {error ? <Problem id={errId}>{error}</Problem> : null}
    </div>
  );
}

/** The personal data consent (G2-PII-04): the text and the policy page of the system, required before the write. */
function Consent({ form, uid, className }: { form: FormModel; uid: string; className?: string }) {
  const c = form.consent;
  if (!c.required) return null;
  const id = `${uid}-consent`;
  const errId = `${id}-error`;
  return (
    <div data-testid="wz-consent" className={className}>
      <div className="flex items-start gap-2">
        <Check
          id={id}
          checked={c.checked}
          onChange={c.set}
          invalid={!!c.error}
          describedBy={c.error ? errId : undefined}
        />
        <label htmlFor={id} className="min-w-0 pt-2.5 text-small text-muted-foreground">
          {c.text}
          {c.policyPage ? (
            <>
              {" "}
              в соответствии с{" "}
              <a
                href={c.policyPage}
                data-testid="wz-consent-policy-link"
                target="_blank"
                rel="noopener"
                className="text-inherit underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                политикой обработки персональных данных
              </a>
            </>
          ) : null}
        </label>
      </div>
      {c.error ? <Problem id={errId}>{c.error}</Problem> : null}
    </div>
  );
}

/** «Sent»: the answer after the write, focused and announced; the action brings an empty form back. */
function Sent({
  title,
  text,
  detail,
  again,
  onAgain,
  framed = true,
}: {
  title: string;
  text?: string;
  /** What was written, in words (a booking: the service, the day and the time). */
  detail?: string;
  again: string;
  onAgain(): void;
  /** In its own frame (false — the section already frames it). */
  framed?: boolean;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus();
  }, []);
  return (
    <div
      role="status"
      className={`flex items-start gap-4 ${framed ? "rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-8" : ""}`}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          className="size-5"
        >
          <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0">
        <h3 ref={head} tabIndex={-1} className="font-display text-h3 font-bold text-balance outline-none">
          {title}
        </h3>
        {detail ? <p className="mt-2 text-lead font-bold">{detail}</p> : null}
        {text ? <p className="mt-2 max-w-text text-body text-muted-foreground">{text}</p> : null}
        <button type="button" onClick={onAgain} className={`mt-6 ${secondaryClass}`}>
          {again}
        </button>
      </div>
    </div>
  );
}

/** Focus after a refused submit: the first field with an error; after «again»: the first field of the new form. */
function useFormFocus(box: RefObject<HTMLFormElement | null>, tries: number, round: number) {
  useEffect(() => {
    if (tries > 0) box.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [tries, box]);
  useEffect(() => {
    if (round > 0) box.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [round, box]);
}

export default function FormCentered(props: FormCenteredProps) {
  const { entity = "lead", fields, title, text, submit, sent, again, note, contact } = props;
  const lead = useLeadForm(entity, fields ? { fields } : {});
  const form = lead.form;
  const uid = useId();
  const box = useRef<HTMLFormElement>(null);
  const [tries, setTries] = useState(0);
  useFormFocus(box, tries, lead.round);
  const shown = form.fields.filter((f) => f.type !== "image" && f.type !== "file");
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!(await form.submit())) setTries((n) => n + 1);
  };
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-muted py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-xl px-gutter">
        <div className="text-center">
          <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
            {title}
          </h2>
          {text ? <p className="mt-4 text-body text-muted-foreground">{text}</p> : null}
        </div>
        <div className="mt-10">
          {lead.sent ? (
            <Sent
              title={sent.title}
              text={sent.text}
              again={again ?? "Отправить ещё одну заявку"}
              onAgain={lead.again}
            />
          ) : !lead.allowed ? (
            <p className="text-center text-body text-muted-foreground">Форма заявки сейчас недоступна.</p>
          ) : (
            <form key={lead.round} ref={box} noValidate onSubmit={onSubmit} aria-labelledby={`${uid}-title`}>
              <div className="space-y-5">
                {shown.map((f) => (
                  <FieldRow key={f.name} field={f} form={form} uid={uid} />
                ))}
                <Consent form={form} uid={uid} />
              </div>
              {form.formError ? (
                <p role="alert" className="mt-5 text-body font-bold">
                  {form.formError}
                </p>
              ) : null}
              <button
                type="submit"
                aria-disabled={form.pending ? true : undefined}
                className={`mt-8 w-full ${primaryClass}`}
              >
                {form.pending ? "Отправляем…" : submit}
              </button>
              {note ? <p className="mt-4 text-center text-small text-muted-foreground">{note}</p> : null}
            </form>
          )}
        </div>
        {contact && !lead.sent ? (
          <div className="mt-10 flex items-center gap-4 text-small text-muted-foreground">
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
            <span>или свяжитесь напрямую</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {contact && !lead.sent ? (
          <p className="mt-4 text-center">
            <a
              href={contact.href}
              className="inline-flex min-h-11 items-center font-display text-h3 font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {contact.label}
            </a>
          </p>
        ) : null}
      </div>
    </section>
  );
}
