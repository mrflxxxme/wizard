// RecordForm (ui-kit.yaml#components.RecordForm): fields from RoleSpec, client validation, server field errors,
// ConsentCheckbox for pii fields of non-admin roles, create/update with {consent: true}.
import type { Field } from "@wizard/appspec";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { cx, useDataSource, useRoleSpec, useWzRoot } from "../data/context.js";
import { entityOf, hasPii, permissionOf, type RoleSpec, titleField } from "../data/roleSpec.js";
import type { Rec, WzError } from "../data/types.js";
import { fieldProblem } from "../data/validate.js";
import { ru } from "../i18n/ru.js";
import { ButtonImpl } from "./Button.js";
import { ConsentCheckboxImpl } from "./ConsentCheckbox.js";
import { FieldImpl } from "./Field.js";
import { FileFieldImpl } from "./FileField.js";
import { ImageFieldImpl } from "./media/ImageField.js";
import styles from "./RecordForm.module.css";
import { part, type RootAttrs } from "./root.js";
import { DataState } from "./States.js";
import type { RecordFormProps } from "./types.js";

// file → FileField (M2-14), image → ImageField (M2-47) (RecordForm.field_mapping); qr_token and json are never edited.
const NEVER = new Set(["qr_token", "json"]);

/** Default field list: visible, editable by the role, not rowFilter-bound, not refs to users (RecordForm.fields). */
export function defaultFormFields(spec: RoleSpec, entity: string): string[] {
  const p = permissionOf(spec, entity);
  const ro = new Set(p?.readonlyFields ?? []);
  const bound = new Set(Object.keys(p?.rowFilter ?? {}));
  return (entityOf(spec, entity)?.fields ?? [])
    .filter((f) => !NEVER.has(f.type) && !ro.has(f.name) && !bound.has(f.name) && f.ref?.entity !== "users")
    .map((f) => f.name);
}

export function RecordForm(props: RecordFormProps): ReactNode {
  const root = useWzRoot("RecordForm", "wz-recordform", props);
  if (props.mode === "edit" && props.id) return <EditLoader {...props} id={props.id} root={root} />;
  return <RecordFormImpl {...props} root={root} initial={props.defaults ?? {}} />;
}

function EditLoader(props: RecordFormProps & { id: string; root: RootAttrs }): ReactNode {
  const r = useDataSource().useRecord<Rec>(props.entity, props.id);
  if (!r.data)
    return (
      <div {...props.root} aria-busy={r.isLoading || undefined}>
        <DataState result={r} lines={4} />
      </div>
    );
  return <RecordFormImpl {...props} initial={r.data} />;
}

/** The form itself; `testBase` names its parts (LeadForm uses «leadform»: wz-leadform-submit, wz-consent--leadform). */
export function RecordFormImpl(
  props: RecordFormProps & { root: RootAttrs; initial: Record<string, unknown>; testBase?: string },
): ReactNode {
  const { root, entity } = props;
  const tb = props.testBase ?? "recordform";
  const spec = useRoleSpec();
  const ds = useDataSource();
  const isEdit = props.mode === "edit";
  const create = ds.useCreate(entity);
  const update = ds.useUpdate(entity);
  const mutation = isEdit ? update : create;
  const ent = entityOf(spec, entity);
  const readonly = new Set(permissionOf(spec, entity)?.readonlyFields ?? []);
  const names = (props.fields ?? defaultFormFields(spec, entity)).filter((n) => {
    const f = ent?.fields.find((x) => x.name === n);
    return f && !NEVER.has(f.type);
  });
  const fields = names.map((n) => ent?.fields.find((f) => f.name === n) as Field);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of fields) v[f.name] = props.initial[f.name] ?? (isEdit ? null : (f.default ?? null));
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>();
  const busy = useRef(false);
  const idBase = root["data-wz-id"] ?? "recordform";

  const isAdmin = !!spec.roles.find((r) => r.name === spec.role)?.isAdmin;
  const editable = (f: Field) => !readonly.has(f.name);
  const sentNames = [...fields.filter(editable).map((f) => f.name), ...Object.keys(props.hidden ?? {})];
  const needsConsent = !isAdmin && sentNames.some((n) => hasPii(ent?.fields.find((f) => f.name === n)));

  const validate = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of fields.filter(editable)) {
      const v = values[f.name];
      const empty = v === null || v === undefined || v === "";
      if (empty) {
        if (f.required) out[f.name] = ru.field.requiredError;
        continue;
      }
      const numeric = ["int", "decimal", "money"].includes(f.type);
      const problem = numeric && typeof v === "string" ? ru.field.number : fieldProblem(f, v);
      if (problem) out[f.name] = problem;
    }
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.current || mutation.pending) return;
    setFormError(undefined);
    const errs = validate();
    setErrors(errs);
    const consentMissing = needsConsent && !consent;
    setConsentError(consentMissing ? ru.consent.error : undefined);
    if (Object.keys(errs).length || consentMissing) return;
    const payload: Record<string, unknown> = { ...(props.hidden ?? {}) };
    for (const f of fields.filter(editable)) {
      const v = values[f.name];
      if (isEdit || (v !== null && v !== "")) payload[f.name] = v === "" ? null : v;
    }
    const opts = needsConsent ? ({ consent: true } as const) : undefined;
    busy.current = true;
    try {
      const rec = isEdit
        ? await update.mutate(String(props.id), payload, opts)
        : await create.mutate(payload, opts);
      props.onSuccess?.(rec);
      if (!isEdit) {
        setValues(
          Object.fromEntries(fields.map((f) => [f.name, props.defaults?.[f.name] ?? f.default ?? null])),
        );
        setConsent(false);
      }
    } catch (err) {
      const w = err as WzError;
      const byField: Record<string, string> = {};
      const rest: string[] = [];
      for (const fe of w.fields ?? []) {
        if (fields.some((f) => f.name === fe.field)) byField[fe.field] = fe.message;
        else rest.push(fe.message);
      }
      setErrors(byField);
      if (w.code === "CONSENT_REQUIRED") setConsentError(w.message);
      else if (!Object.keys(byField).length || rest.length) setFormError(w.message);
    } finally {
      busy.current = false;
    }
  };

  return (
    <form {...root} className={cx(styles.form, props.className)} onSubmit={(e) => void submit(e)} noValidate>
      {fields.map((f) => {
        const common = {
          root: part(`wz-field-${f.name}`),
          idBase,
          name: f.name,
          label: f.label,
          type: f.type,
          value: values[f.name],
          onChange: (v: unknown) => setValues((o) => ({ ...o, [f.name]: v })),
          required: !!f.required,
          error: errors[f.name],
          min: f.min,
          max: f.max,
          maxLength: f.maxLength,
          disabled: !editable(f),
          readOnly: !editable(f),
          enumOptions: f.enum,
        };
        if (f.type === "image")
          return (
            <ImageFieldImpl
              key={f.name}
              root={part(`wz-imagefield-${f.name}`)}
              name={f.name}
              label={f.label}
              entity={entity}
              value={typeof values[f.name] === "string" ? (values[f.name] as string) : null}
              onChange={common.onChange}
              required={common.required}
              error={common.error}
              disabled={common.disabled}
            />
          );
        if (f.type === "file")
          return (
            <FileFieldImpl
              key={f.name}
              root={part(`wz-filefield-${f.name}`)}
              name={f.name}
              label={f.label}
              entity={entity}
              value={typeof values[f.name] === "string" ? (values[f.name] as string) : null}
              onChange={common.onChange}
              required={common.required}
              error={common.error}
              disabled={common.disabled}
            />
          );
        return f.type === "ref" && f.ref ? (
          <RefField key={f.name} target={f.ref.entity} {...common} />
        ) : (
          <FieldImpl key={f.name} {...common} />
        );
      })}
      {needsConsent && (
        <ConsentCheckboxImpl
          root={part(`wz-consent--${tb}`)}
          checked={consent}
          onChange={(c) => {
            setConsent(c);
            if (c) setConsentError(undefined);
          }}
          error={consentError}
        />
      )}
      {formError && (
        <p role="alert" className={styles.alert} data-testid={`wz-${tb}-error`}>
          {formError}
        </p>
      )}
      <div className={styles.actions}>
        <ButtonImpl root={part(`wz-${tb}-submit`)} type="submit" variant="primary" loading={mutation.pending}>
          {props.submitLabel ?? (isEdit ? ru.recordForm.edit : ru.recordForm.create)}
        </ButtonImpl>
        {props.onCancel && (
          <ButtonImpl root={part(`wz-${tb}-cancel`)} variant="ghost" onClick={props.onCancel}>
            {ru.recordForm.cancel}
          </ButtonImpl>
        )}
      </div>
    </form>
  );
}

/** ref → select over records of the target entity with server search (useList search). */
function RefField(props: Parameters<typeof FieldImpl>[0] & { target: string }): ReactNode {
  const { target, ...rest } = props;
  const spec = useRoleSpec();
  const [search, setSearch] = useState("");
  const caption = titleField(spec, target);
  const list = useDataSource().useList<Rec>(target, {
    pageSize: 50,
    ...(search ? { search } : {}),
    ...(caption ? { sort: { field: caption, dir: "asc" as const } } : {}),
  });
  const options = (list.data?.items ?? []).map((r) => ({
    value: r.id,
    label: caption ? String(r[caption] ?? r.id) : r.id,
  }));
  const current = typeof rest.value === "string" ? rest.value : "";
  if (current && !options.some((o) => o.value === current))
    options.unshift({ value: current, label: current });
  const searchId = `wz-${rest.idBase}-${rest.name}-search`.replace(/[^A-Za-z0-9_:.-]/g, "_");
  return (
    <FieldImpl {...rest} type="ref" enumOptions={options}>
      {(list.data?.total ?? 0) > 10 || search ? (
        <input
          id={searchId}
          type="search"
          className={styles.search}
          aria-label={ru.field.searchIn(rest.label)}
          placeholder={ru.field.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={rest.disabled}
        />
      ) : null}
    </FieldImpl>
  );
}
