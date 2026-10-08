// The form model of ui-kit (V3-10, specs/agents/builder-v3.md §3 C4): fields from the role's RoleSpec, client
// validation, server field errors, the personal data consent (G2-PII-04: a non-admin role sending a pii field must
// consent; the write goes with {consent: true}) and create/update over the DataSource (@wizard/sdk by default). No
// markup: RecordForm (and LeadForm through it) renders it, the headless hooks hand it to the patterns of v3.
import type { Entity, Field } from "@wizard/appspec";
import { useRef, useState } from "react";
import { useDataSource, useRoleSpec } from "../../data/context.js";
import { entityOf, hasPii, permissionOf, type RoleSpec } from "../../data/roleSpec.js";
import type { Rec, WzError } from "../../data/types.js";
import { fieldProblem } from "../../data/validate.js";
import { ru } from "../../i18n/ru.js";

/** Field types a form never edits (RecordForm.field_mapping): qr_token and json. */
export const NEVER_EDITED: ReadonlySet<string> = new Set(["qr_token", "json"]);

/** Default field list: visible, editable by the role, not rowFilter-bound, not refs to users (RecordForm.fields). */
export function defaultFormFields(spec: RoleSpec, entity: string): string[] {
  const p = permissionOf(spec, entity);
  const ro = new Set(p?.readonlyFields ?? []);
  const bound = new Set(Object.keys(p?.rowFilter ?? {}));
  return (entityOf(spec, entity)?.fields ?? [])
    .filter(
      (f) => !NEVER_EDITED.has(f.type) && !ro.has(f.name) && !bound.has(f.name) && f.ref?.entity !== "users",
    )
    .map((f) => f.name);
}

export interface FormModelOptions {
  entity: string;
  mode?: "create" | "edit";
  /** Record id of the edit mode. */
  id?: string;
  /** Field names (default: defaultFormFields). */
  fields?: readonly string[];
  /** Values sent with every write without being shown (e.g. the chosen time of a booking). */
  hidden?: Readonly<Record<string, unknown>>;
  /** Initial values: the record in the edit mode, the defaults in the create mode. */
  initial?: Readonly<Record<string, unknown>>;
  /** Values the create mode resets to after a write (default: the fields' defaults). */
  defaults?: Readonly<Record<string, unknown>>;
  onSuccess?(record: Rec): void;
  /** A write error the caller handles itself (true — the form shows nothing), e.g. CONFLICT of a taken time. */
  onError?(error: WzError): boolean;
  /** A check before the write (e.g. a package on the day of a visit): a Russian message stops it. */
  beforeWrite?(payload: Record<string, unknown>): Promise<string | null | undefined>;
}

/** Consent to the processing of personal data: required for a non-admin role sending a pii field. */
export interface ConsentModel {
  required: boolean;
  checked: boolean;
  set(checked: boolean): void;
  error?: string;
  /** Text and policy page of the system (RoleSpec.compliance), as ConsentCheckbox shows them. */
  text: string;
  policyPage?: string;
}

export interface FormModel {
  entity: Entity | undefined;
  /** Fields of the form, in order. */
  fields: Field[];
  /** The role may write the field (not read-only for it). */
  editable(field: Field): boolean;
  values: Readonly<Record<string, unknown>>;
  setValue(name: string, value: unknown): void;
  /** Russian messages by field: client validation and the server's field errors. */
  errors: Readonly<Record<string, string>>;
  /** A Russian message about the form as a whole. */
  formError?: string;
  consent: ConsentModel;
  pending: boolean;
  /** Validates, asks for consent, writes; the record or undefined when nothing was written. */
  submit(): Promise<Rec | undefined>;
}

/** Form state over the DataSource and the RoleSpec of the WzProvider (shared by RecordForm and the v3 hooks). */
export function useFormModel(o: FormModelOptions): FormModel {
  const { entity } = o;
  const spec = useRoleSpec();
  const ds = useDataSource();
  const isEdit = o.mode === "edit";
  const create = ds.useCreate(entity);
  const update = ds.useUpdate(entity);
  const mutation = isEdit ? update : create;
  const ent = entityOf(spec, entity);
  const readonly = new Set(permissionOf(spec, entity)?.readonlyFields ?? []);
  const names = (o.fields ?? defaultFormFields(spec, entity)).filter((n) => {
    const f = ent?.fields.find((x) => x.name === n);
    return f && !NEVER_EDITED.has(f.type);
  });
  const fields = names.map((n) => ent?.fields.find((f) => f.name === n) as Field);
  const initial = o.initial ?? {};
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of fields) v[f.name] = initial[f.name] ?? (isEdit ? null : (f.default ?? null));
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>();
  const busy = useRef(false);

  const isAdmin = !!spec.roles.find((r) => r.name === spec.role)?.isAdmin;
  const editable = (f: Field) => !readonly.has(f.name);
  const sentNames = [...fields.filter(editable).map((f) => f.name), ...Object.keys(o.hidden ?? {})];
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

  const submit = async (): Promise<Rec | undefined> => {
    if (busy.current || mutation.pending) return undefined;
    setFormError(undefined);
    const errs = validate();
    setErrors(errs);
    const consentMissing = needsConsent && !consent;
    setConsentError(consentMissing ? ru.consent.error : undefined);
    if (Object.keys(errs).length || consentMissing) return undefined;
    const payload: Record<string, unknown> = { ...(o.hidden ?? {}) };
    for (const f of fields.filter(editable)) {
      const v = values[f.name];
      if (isEdit || (v !== null && v !== "")) payload[f.name] = v === "" ? null : v;
    }
    const opts = needsConsent ? ({ consent: true } as const) : undefined;
    busy.current = true;
    try {
      const stop = o.beforeWrite ? await o.beforeWrite(payload) : undefined;
      if (stop) {
        setFormError(stop);
        return undefined;
      }
      const rec = isEdit
        ? await update.mutate(String(o.id), payload, opts)
        : await create.mutate(payload, opts);
      o.onSuccess?.(rec);
      if (!isEdit) {
        setValues(Object.fromEntries(fields.map((f) => [f.name, o.defaults?.[f.name] ?? f.default ?? null])));
        setConsent(false);
      }
      return rec;
    } catch (err) {
      const w = err as WzError;
      if (o.onError?.(w)) return undefined;
      const byField: Record<string, string> = {};
      const rest: string[] = [];
      for (const fe of w.fields ?? []) {
        if (fields.some((f) => f.name === fe.field)) byField[fe.field] = fe.message;
        else rest.push(fe.message);
      }
      setErrors(byField);
      if (w.code === "CONSENT_REQUIRED") setConsentError(w.message);
      else if (!Object.keys(byField).length || rest.length) setFormError(w.message);
      return undefined;
    } finally {
      busy.current = false;
    }
  };

  return {
    entity: ent,
    fields,
    editable,
    values,
    setValue: (name, value) => setValues((v) => ({ ...v, [name]: value })),
    errors,
    ...(formError !== undefined ? { formError } : {}),
    consent: {
      required: needsConsent,
      checked: consent,
      set: (c) => {
        setConsent(c);
        if (c) setConsentError(undefined);
      },
      ...(consentError !== undefined ? { error: consentError } : {}),
      text: spec.compliance?.consentText ?? ru.consent.defaultText,
      ...(spec.compliance?.policyPage ? { policyPage: spec.compliance.policyPage } : {}),
    },
    pending: mutation.pending,
    submit,
  };
}
