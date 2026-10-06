// compile.ts of «Заявки» (manifest.hook): the lead entity from form_fields and contact — a required contact is added
// to the form even when the plan left it out of form_fields, which substitution and AND-only conditions cannot express.
import type { Field, ModuleFragments } from "@wizard/appspec";
import type { ModuleContext } from "../types.js";

/** Lead fields the form may show (canonical names; status is added by the module). */
const FORM_FIELDS: Readonly<Record<string, Field>> = {
  name: { name: "name", label: "Имя", type: "string", maxLength: 120, pii: "basic", piiKind: "fio" },
  phone: { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
  email: { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
  comment: {
    name: "comment",
    label: "Комментарий",
    type: "text",
    maxLength: 2000,
    pii: "basic",
    piiKind: "free_text",
  },
  preferred_time: { name: "preferred_time", label: "Удобное время", type: "string", maxLength: 120 },
};

/** Lead status: canonical values, metrics count in_work and done as handled. */
export const LEAD_STATUSES = [
  { value: "new", label: "Новая" },
  { value: "in_work", label: "В работе" },
  { value: "done", label: "Закрыта" },
] as const;

/** Form fields in the plan's order; the required contact goes right after the name when the plan omitted it. */
export function leadFormFields(formFields: readonly string[], contact: string): string[] {
  const out = [...formFields];
  if ((contact === "phone" || contact === "email") && !out.includes(contact))
    out.splice(out[0] === "name" ? 1 : 0, 0, contact);
  return out;
}

/**
 * «Мои заявки» of the visitor cabinet (B2-16): the contact the visitor logs in with ($user.email or $user.phone) —
 * the lead keeps it (added to the form when the plan left it out) and the visitor reads only his leads by it.
 */
export function visitorLeadContact(ctx: ModuleContext): "email" | "phone" | null {
  const vc = ctx.allParams.visitor_cabinet;
  if (!ctx.present.has("visitor_cabinet") || vc?.show_leads !== true) return null;
  return vc.login === "phone_otp" ? "phone" : "email";
}

export function compileLeads(ctx: ModuleContext): ModuleFragments {
  const contact = String(ctx.params.contact ?? "any");
  const names = leadFormFields((ctx.params.form_fields as string[] | undefined) ?? [], contact);
  const mine = visitorLeadContact(ctx);
  if (mine && !names.includes(mine)) names.push(mine);
  const fields: Field[] = names.flatMap((n) => {
    const f = FORM_FIELDS[n];
    if (!f) return [];
    const required = n === "name" || n === contact;
    return [{ ...f, ...(required ? { required: true } : {}) }];
  });
  // with_service: the item of «Каталог и прайс» (required by the manifest's requires) the visitor asks about.
  if (ctx.params.with_service === true)
    fields.push({
      name: "service",
      label: "Услуга",
      type: "ref",
      ref: { entity: "service", onDelete: "set_null" },
    });
  fields.push({
    name: "status",
    label: "Статус",
    type: "enum",
    required: true,
    default: "new",
    enum: LEAD_STATUSES.map((s) => ({ ...s })),
  });
  return {
    entities: [
      {
        value: {
          name: "lead",
          label: "Заявка",
          fields,
          indexes: [{ fields: ["status"] }],
          retention: { deleteAfterDays: ctx.params.retention_days },
        },
      },
    ],
    ...(mine
      ? {
          permissions: [
            {
              value: {
                role: "$visitor",
                entity: "lead",
                ops: ["read"],
                rowFilter: { [mine]: `$user.${mine}` },
              },
            },
          ],
        }
      : {}),
  };
}
