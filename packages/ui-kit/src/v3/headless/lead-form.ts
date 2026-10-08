// useLeadForm (V3-10, C4): the lead form of a v3 page without markup — the logic of the LeadForm block: the role may
// create the entity or the form is unavailable; fields, validation and the personal data consent of the form model
// (G2-PII-04); after a write the form shows «sent» until the visitor asks for another one.
import { useState } from "react";
import { useCan } from "../../data/context.js";
import type { Rec } from "../../data/types.js";
import { type FormModel, type FormModelOptions, useFormModel } from "./form.js";

export interface UseLeadFormOptions {
  /** Field names (default: what the role may fill — defaultFormFields). */
  fields?: readonly string[];
  /** Values sent without being shown (a source page, a chosen service). */
  hidden?: Readonly<Record<string, unknown>>;
  defaults?: Readonly<Record<string, unknown>>;
  onSuccess?(record: Rec): void;
}

export interface LeadFormModel {
  /** The role may create the entity; otherwise a pattern shows «Форма заявки сейчас недоступна». */
  allowed: boolean;
  /** The record of the last successful write («Заявка отправлена»), null before it. */
  sent: Rec | null;
  /** Back to an empty form after «sent». */
  again(): void;
  /** The form itself: fields, values, errors, consent, submit. Remount it by `round` after again(). */
  form: FormModel;
  /** Changes on again(): a key for the form element, so it starts clean. */
  round: number;
}

/** Lead form over the DataSource of the WzProvider (@wizard/sdk by default): create on `entity` with consent. */
export function useLeadForm(entity: string, o: UseLeadFormOptions = {}): LeadFormModel {
  const can = useCan();
  const [sent, setSent] = useState<Rec | null>(null);
  const [round, setRound] = useState(0);
  const opts: FormModelOptions = {
    entity,
    mode: "create",
    initial: o.defaults ?? {},
    ...(o.fields ? { fields: o.fields } : {}),
    ...(o.hidden ? { hidden: o.hidden } : {}),
    ...(o.defaults ? { defaults: o.defaults } : {}),
    onSuccess: (rec) => {
      setSent(rec);
      o.onSuccess?.(rec);
    },
  };
  const form = useFormModel(opts);
  return {
    allowed: can("create", entity),
    sent,
    again: () => {
      setSent(null);
      setRound((r) => r + 1);
    },
    form,
    round,
  };
}
