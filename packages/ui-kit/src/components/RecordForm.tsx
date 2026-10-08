// RecordForm (ui-kit.yaml#components.RecordForm): fields from RoleSpec, client validation, server field errors,
// ConsentCheckbox for pii fields of non-admin roles, create/update with {consent: true}. The state is the form model of
// the v3 headless hooks (useFormModel, V3-10) — one logic for the v2 forms and the patterns of v3.
import { type ReactNode, useState } from "react";
import { cx, useDataSource, useRoleSpec, useWzRoot } from "../data/context.js";
import { titleField } from "../data/roleSpec.js";
import type { Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { type FormModel, useFormModel } from "../v3/headless/form.js";
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
/** Default field list: visible, editable by the role, not rowFilter-bound, not refs to users (RecordForm.fields). */
export { defaultFormFields } from "../v3/headless/form.js";

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
  const m = useFormModel({
    entity: props.entity,
    mode: props.mode === "edit" ? "edit" : "create",
    ...(props.id !== undefined ? { id: props.id } : {}),
    ...(props.fields ? { fields: props.fields } : {}),
    ...(props.hidden ? { hidden: props.hidden } : {}),
    initial: props.initial,
    ...(props.defaults ? { defaults: props.defaults } : {}),
    ...(props.onSuccess ? { onSuccess: props.onSuccess } : {}),
  });
  return <RecordFormView {...props} model={m} />;
}

/** The markup of a form model (useFormModel, or useLeadForm of the LeadForm block). */
export function RecordFormView(
  props: Pick<RecordFormProps, "entity" | "mode" | "submitLabel" | "onCancel" | "className"> & {
    root: RootAttrs;
    testBase?: string;
    model: FormModel;
  },
): ReactNode {
  const { root, entity, model: m } = props;
  const tb = props.testBase ?? "recordform";
  const isEdit = props.mode === "edit";
  const { fields, values, errors, editable } = m;
  const idBase = root["data-wz-id"] ?? "recordform";

  return (
    <form
      {...root}
      className={cx(styles.form, props.className)}
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
      noValidate
    >
      {fields.map((f) => {
        const common = {
          root: part(`wz-field-${f.name}`),
          idBase,
          name: f.name,
          label: f.label,
          type: f.type,
          value: values[f.name],
          onChange: (v: unknown) => m.setValue(f.name, v),
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
      {m.consent.required && (
        <ConsentCheckboxImpl
          root={part(`wz-consent--${tb}`)}
          checked={m.consent.checked}
          onChange={m.consent.set}
          error={m.consent.error}
        />
      )}
      {m.formError && (
        <p role="alert" className={styles.alert} data-testid={`wz-${tb}-error`}>
          {m.formError}
        </p>
      )}
      <div className={styles.actions}>
        <ButtonImpl root={part(`wz-${tb}-submit`)} type="submit" variant="primary" loading={m.pending}>
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
