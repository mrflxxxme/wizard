// The key window drawn by the platform in the chat (V3-21): which integration asks, who asked and why, the hosts the key
// will go to, a masked field; the key is encrypted in the browser (seal.ts) and the field is cleared at once. After
// saving: the last 4 characters and the check — never the value again; rotation, re-check and removal.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { KeyWindowWithKey, PassportForm, SystemKey } from "./client.js";
import s from "./KeyWindow.module.css";
import { keysRu } from "./texts.js";

const T = keysRu;

/** Why a key cannot be sent (the server's rules of secrets-v3/vault.ts keyProblem), or null. */
export function keyFormatProblem(value: string, name = ""): string | null {
  const v = value.trim();
  // V3-23: ЮKassa shopId next to its key — digits, no length minimum (mirror of the server's keyProblem).
  if (/_shop_id$/.test(name)) return /^\d{3,12}$/.test(v) ? null : T.format.shopId;
  if (v.startsWith("secret://")) return T.format.ref;
  if (v.length < 8) return T.format.short;
  if (v.length > 4096) return T.format.long;
  if (!/^[\x21-\x7e]+$/.test(v)) return T.format.chars;
  return null;
}

export function Hosts({
  hosts,
  label = T.window.hosts,
}: {
  hosts: readonly string[];
  label?: string;
}): ReactNode {
  return (
    <>
      <p className={s.hostsLabel}>{label}</p>
      <ul className={s.hosts} data-testid="key-hosts">
        {hosts.map((h) => (
          <li key={h} className={s.host}>
            {h}
          </li>
        ))}
      </ul>
    </>
  );
}

export interface KeyWindowFormProps {
  /** The open window with its public key; null while it opens. */
  window: KeyWindowWithKey | null;
  /** The stored key of this name (rotation), if any. */
  current: SystemKey | null;
  /** A key the chat intercepted: it moves here in memory, never into a message. */
  initialValue?: string;
  editable: boolean;
  busy: boolean;
  error: string | null;
  /** Encrypt and send; the form clears its field before awaiting. */
  onSubmit(value: string): void;
  onCancel(): void;
}

/** A field of the window: the one key, or a field of an API passport (V3-22). */
interface FieldDef {
  key: string;
  label: string;
  hint: string;
  example: string;
  secret: boolean;
  pattern: RegExp | null;
  error: string | null;
}

const SINGLE: FieldDef[] = [
  {
    key: "key",
    label: T.window.label,
    hint: T.window.hint,
    example: "",
    secret: true,
    pattern: null,
    error: null,
  },
];

function fieldsOf(form: PassportForm | null): FieldDef[] {
  if (!form) return SINGLE;
  return form.fields.map((f) => {
    let pattern: RegExp | null = null;
    try {
      pattern = f.pattern ? new RegExp(f.pattern, f.flags) : null;
    } catch {
      pattern = null;
    }
    return {
      key: f.key,
      label: f.label_ru,
      hint: f.hint_ru,
      example: f.example,
      secret: f.secret,
      pattern,
      error: f.error_ru,
    };
  });
}

/** The host of an account typed into a passport field (the same reading as passportAccountFromUrl), or null. */
export function accountHost(spec: NonNullable<PassportForm["account"]>, raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  let host: string | null;
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(t)) host = `${t}.${spec.suffixes[0]}`;
  else
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/\.$/, "");
    } catch {
      host = null;
    }
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const suffix = spec.suffixes.find((x) => host.endsWith(`.${x}`));
  if (suffix) {
    const sub = host.slice(0, -suffix.length - 1);
    return sub.includes(".") || spec.reserved.includes(sub) ? null : host;
  }
  return spec.customHost ? host : null;
}

/** Why the passport fields cannot be sent (the shape checks of the passport), or null. */
function passportProblem(
  form: PassportForm,
  defs: FieldDef[],
  values: Record<string, string>,
): string | null {
  for (const f of defs) {
    const v = (values[f.key] ?? "").trim();
    if (!v) return T.form.empty(f.label);
    if (/\s/.test(v) || v.length > 4096) return T.form.spaces(f.label);
    if (f.pattern && !f.pattern.test(v)) return f.error ?? T.form.wrong(f.label);
  }
  if (form.account && !accountHost(form.account, values[form.account.field] ?? ""))
    return T.form.account(form.account.label_ru, form.account.example);
  return null;
}

/** The form of an open window. */
export function KeyWindowForm(p: KeyWindowFormProps): ReactNode {
  const id = useId();
  const w = p.window;
  const form = w?.form ?? null;
  const defs = fieldsOf(form);
  const firstSecret = defs.find((f) => f.secret)?.key ?? defs[0]?.key ?? "key";
  // Open fields (an account address, a shop id) are state; secret fields stay uncontrolled — their value lives only in
  // the input's property, never in a DOM attribute or in React state.
  const [values, setValues] = useState<Record<string, string>>({});
  const secrets = useRef<Record<string, HTMLInputElement | null>>({});
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const first = useRef<HTMLInputElement | null>(null);
  const initial = useRef(p.initialValue);
  // The intercepted key moves into the first secret field; the first field takes the focus when the window is ready.
  useEffect(() => {
    if (!w || !p.editable) return;
    const el = secrets.current[firstSecret];
    if (el && initial.current) {
      el.value = initial.current;
      initial.current = undefined;
    }
    first.current?.focus();
  }, [w, p.editable, firstSecret]);

  const read = (): Record<string, string> =>
    Object.fromEntries(
      defs.map((f) => [f.key, f.secret ? (secrets.current[f.key]?.value ?? "") : (values[f.key] ?? "")]),
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    const all = read();
    const bad = form
      ? passportProblem(form, defs, all)
      : keyFormatProblem(all.key ?? "", p.window?.name ?? "");
    if (bad) {
      setProblem(bad);
      first.current?.focus();
      return;
    }
    const payload = form
      ? JSON.stringify({ fields: Object.fromEntries(defs.map((f) => [f.key, (all[f.key] ?? "").trim()])) })
      : (all.key ?? "");
    // The fields never keep the key once it is handed over for encryption.
    for (const el of Object.values(secrets.current)) if (el) el.value = "";
    setValues({});
    setShown(false);
    setProblem(null);
    p.onSubmit(payload);
  }

  // Per-account APIs: the key goes to the account being typed — shown as it is typed.
  const live = form?.account ? accountHost(form.account, values[form.account.field] ?? "") : null;
  const hosts = form?.account ? (live ? [live] : null) : (w?.hosts ?? []);
  const name = w ? (w.integrationName ?? w.name) : "";
  return (
    <section className={s.card} aria-labelledby={`${id}-t`} data-testid="key-window">
      <div className={s.head}>
        <p className={s.title} id={`${id}-t`}>
          {w ? T.window.title(name) : T.window.loading}
        </p>
        {w && (
          <p className={s.who} data-testid="key-window-who">
            {w.requestedBy === "agent" ? T.window.byAgent : T.window.byUser}
          </p>
        )}
      </div>
      {w && (
        <>
          <p className={s.purpose} data-testid="key-window-purpose">
            {w.purpose}
          </p>
          {hosts ? (
            <Hosts hosts={hosts} />
          ) : (
            <p className={s.meta} data-testid="key-hosts-account">
              {T.window.accountHosts(form?.account?.label_ru ?? "", form?.account?.suffixes ?? [])}
            </p>
          )}
          {form && (
            <p className={s.meta} data-testid="key-window-where">
              {form.where_ru}
            </p>
          )}
          <p className={s.note}>{T.window.safety(w.secretRef)}</p>
          {p.current && (
            <p className={s.meta} data-testid="key-window-current">
              {T.window.current(p.current.last4, p.current.status === "ok")}. {T.window.rotation}
            </p>
          )}
        </>
      )}
      {w && !p.editable && <p className={s.meta}>{T.window.viewer}</p>}
      {w && p.editable && (
        <form className={s.form} onSubmit={submit} noValidate autoComplete="off">
          {defs.map((f, i) => (
            <div key={f.key} className={s.form}>
              <label className={s.label} htmlFor={`${id}-${f.key}`}>
                {f.label}
              </label>
              <div className={s.inputRow}>
                <input
                  ref={(el) => {
                    if (i === 0) first.current = el;
                    if (f.secret) secrets.current[f.key] = el;
                  }}
                  id={`${id}-${f.key}`}
                  className={s.input}
                  type={f.secret && !shown ? "password" : "text"}
                  name={`wz-key-window-${f.key}`}
                  {...(f.secret ? {} : { value: values[f.key] ?? "" })}
                  placeholder={f.example || undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!f.secret) setValues((x) => ({ ...x, [f.key]: v }));
                    if (problem) setProblem(null);
                  }}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode={f.secret ? undefined : "url"}
                  data-lpignore="true"
                  data-1p-ignore=""
                  aria-describedby={`${id}-${f.key}-h${problem ? ` ${id}-e` : ""}`}
                  aria-invalid={problem ? true : undefined}
                  disabled={p.busy}
                  data-testid={form ? `key-field-${f.key}` : "key-input"}
                />
                {f.key === firstSecret && f.secret && (
                  <button
                    type="button"
                    className={s.toggle}
                    aria-pressed={shown}
                    onClick={() => setShown((x) => !x)}
                    data-testid="key-show"
                  >
                    {shown ? T.window.hide : T.window.show}
                  </button>
                )}
              </div>
              <p className={s.meta} id={`${id}-${f.key}-h`}>
                {f.hint}
              </p>
            </div>
          ))}
          {(problem ?? p.error) && (
            <p className={s.error} role="alert" id={`${id}-e`} data-testid="key-error">
              {problem ?? p.error}
            </p>
          )}
          <div className={s.actions}>
            <ActionButton type="submit" variant="primary" busy={p.busy} disabled={p.busy} testId="key-save">
              {p.busy ? T.window.saving : T.window.save}
            </ActionButton>
            <ActionButton variant="ghost" disabled={p.busy} onClick={p.onCancel} testId="key-cancel">
              {T.window.cancel}
            </ActionButton>
          </div>
        </form>
      )}
      {(!w || !p.editable) && (
        <div className={s.actions}>
          {p.error && (
            <p className={s.error} role="alert" data-testid="key-error">
              {p.error}
            </p>
          )}
          <ActionButton variant="ghost" onClick={p.onCancel} testId="key-cancel">
            {T.window.cancel}
          </ActionButton>
        </div>
      )}
    </section>
  );
}

export interface KeyResultProps {
  message: string;
  tone: "good" | "bad";
  secret: SystemKey | null;
  editable: boolean;
  busy: "check" | "remove" | null;
  onDone(): void;
  onRotate(): void;
  onCheck(): void;
  onRemove(): void;
}

/** After saving or a check: the result in words, the last 4 characters; rotation, re-check, removal. */
export function KeyResult(p: KeyResultProps): ReactNode {
  const id = useId();
  const [confirm, setConfirm] = useState(false);
  return (
    <section className={s.card} aria-labelledby={`${id}-t`} data-testid="key-result">
      <p className={s.title} id={`${id}-t`}>
        {p.secret ? T.window.title(p.secret.integrationName ?? p.secret.name) : T.region}
      </p>
      <p
        className={`${s.result} ${p.tone === "good" ? s.good : s.bad}`}
        role="status"
        data-testid="key-result-text"
      >
        {p.message}
      </p>
      {p.secret && <Hosts hosts={p.secret.hosts} label={T.window.hosts} />}
      {confirm ? (
        <fieldset className={`${s.options} ${s.actions}`}>
          <legend className={s.itemText}>{T.result.removeConfirm}</legend>
          <ActionButton
            variant="primary"
            busy={p.busy === "remove"}
            disabled={p.busy !== null}
            onClick={p.onRemove}
            testId="key-remove-yes"
          >
            {T.result.removeYes}
          </ActionButton>
          <ActionButton variant="ghost" onClick={() => setConfirm(false)} testId="key-remove-no">
            {T.window.cancel}
          </ActionButton>
        </fieldset>
      ) : (
        <div className={s.actions}>
          <ActionButton variant="primary" size="sm" onClick={p.onDone} testId="key-done">
            {T.result.done}
          </ActionButton>
          {p.editable && p.secret && (
            <>
              <ActionButton size="sm" disabled={p.busy !== null} onClick={p.onRotate} testId="key-rotate">
                {T.result.rotate}
              </ActionButton>
              <ActionButton
                size="sm"
                busy={p.busy === "check"}
                disabled={p.busy !== null}
                onClick={p.onCheck}
                testId="key-check"
              >
                {p.busy === "check" ? T.result.checking : T.result.check}
              </ActionButton>
              <ActionButton
                size="sm"
                variant="ghost"
                disabled={p.busy !== null}
                onClick={() => setConfirm(true)}
                testId="key-remove"
              >
                {T.result.remove}
              </ActionButton>
            </>
          )}
        </div>
      )}
    </section>
  );
}
