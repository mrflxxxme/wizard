// compile.ts of «Клиенты с историей» (manifest.hook): the client entity with the tag enum built from the plan's tag
// list, notes when enabled, and — with «Заявки» in the plan — a G1 scenario that two leads with one contact give one
// client whose history holds both leads (data of the scenario follows the leads module's form fields).
import type { Field, ModuleFragments } from "@wizard/appspec";
import { leadFormFields } from "../leads/compile.js";
import type { ModuleContext } from "../types.js";

/** Contact fields the client is matched by (canonical names, also on the lead). */
export const CLIENT_CONTACTS = ["phone", "email"] as const;
export type ClientContact = (typeof CLIENT_CONTACTS)[number];

/** Enum options of the tag field: tag_1…tag_N in the plan's order, labels as the plan wrote them. */
export function clientTagOptions(tags: readonly string[]): { value: string; label: string }[] {
  return tags.map((label, i) => ({
    value: `tag_${i + 1}`,
    label: label.trim().slice(0, 80) || `Метка ${i + 1}`,
  }));
}

type ExtraField = { name: string; type: string; required?: boolean; options?: { value: string }[] };

/** A neutral sample value of a field type for G1 scenarios; undefined — the type cannot be filled by a scenario. */
function sample(f: ExtraField): unknown {
  switch (f.type) {
    case "int":
    case "decimal":
    case "money":
      return 1;
    case "bool":
      return true;
    case "date":
      return "2026-01-15";
    case "datetime":
      return "2026-01-15T10:00:00.000Z";
    case "enum":
      return f.options?.[0]?.value;
    case "email":
      return "sample@example.com";
    case "phone":
      return "+79990000002";
    case "url":
      return "https://example.com";
    case "image":
      return undefined;
    default:
      return "Пример";
  }
}

const SAMPLE_PHONE = "+79990000001";
const SAMPLE_EMAIL = "client.sample@example.com";

/**
 * Data of a lead for G1 scenarios from the plan's lead form (the leads module's fields with its required contact and
 * the required extra fields); null when a required field cannot be filled by a scenario.
 */
export function leadSampleData(
  leadParams: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const contact = String(leadParams.contact ?? "any");
  const names = leadFormFields((leadParams.form_fields as string[] | undefined) ?? [], contact);
  const data: Record<string, unknown> = {};
  if (names.includes("name")) data.name = "Пример клиента";
  if (names.includes("phone")) data.phone = SAMPLE_PHONE;
  if (names.includes("email")) data.email = SAMPLE_EMAIL;
  for (const f of (leadParams.extra_fields ?? []) as ExtraField[]) {
    if (!f.required) continue;
    const v = sample(f);
    if (v === undefined) return null;
    data[f.name] = v;
  }
  return data;
}

/**
 * Scenario «две заявки с одним контактом — один клиент, обе заявки в его истории» for the plan's lead form; null when
 * the lead has no contact to match by or a required field a scenario cannot fill.
 */
export function leadHistoryScenario(
  leadParams: Readonly<Record<string, unknown>>,
  matchBy: ClientContact,
): Record<string, unknown> | null {
  const data = leadSampleData(leadParams);
  const key: ClientContact | undefined =
    data && matchBy in data ? matchBy : CLIENT_CONTACTS.find((c) => data && c in data);
  if (!data || !key) return null;
  const value = key === "phone" ? SAMPLE_PHONE : SAMPLE_EMAIL;
  return {
    text: "Две заявки с одним контактом дают одного клиента, и обе заявки видны в его истории",
    check: {
      type: "scenario",
      steps: [
        { create: { entity: "lead", data, save: "first" }, consent: true },
        { create: { entity: "lead", data, save: "second" }, consent: true },
        { runWorkflows: {} },
        { as: { role: "owner" } },
        { read: { entity: "client", where: { [key]: value } } },
        { expect: { count: 1 } },
        { read: { entity: "lead", id: "$first.id", save: "lead" } },
        { read: { entity: "lead", where: { client: "$lead.client" } } },
        { expect: { count: 2 } },
      ],
    },
  };
}

/** The plan gave the client a required extra field: a lead cannot create a client by itself. */
export const requiredExtra = (ctx: ModuleContext): boolean =>
  ((ctx.params.extra_fields ?? []) as ExtraField[]).some((f) => f.required);

export function compileClientCard(ctx: ModuleContext): ModuleFragments {
  const tags = (ctx.params.tags as string[] | undefined) ?? [];
  const fields: Field[] = [
    {
      name: "name",
      label: "Имя",
      type: "string",
      required: true,
      maxLength: 120,
      pii: "basic",
      piiKind: "fio",
    },
    { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
    { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
  ];
  if (tags.length) fields.push({ name: "tag", label: "Метка", type: "enum", enum: clientTagOptions(tags) });
  const retention = { deleteAfterDays: ctx.params.retention_days, anchorField: "updated_at" };
  const out: ModuleFragments = {
    entities: [
      {
        value: {
          name: "client",
          label: ctx.params.client_label,
          fields,
          indexes: [{ fields: ["phone"] }, { fields: ["email"] }],
          retention,
        },
      },
    ],
  };
  if (ctx.params.notes)
    out.entities?.push({
      value: {
        name: "client_note",
        label: "Заметка",
        fields: [
          {
            name: "client",
            label: String(ctx.params.client_label),
            type: "ref",
            required: true,
            ref: { entity: "client", onDelete: "cascade" },
          },
          {
            name: "text",
            label: "Заметка",
            type: "text",
            required: true,
            maxLength: 2000,
            pii: "basic",
            piiKind: "free_text",
          },
        ],
        retention,
      },
    });
  const leads = ctx.allParams.leads;
  if (ctx.present.has("leads") && leads) {
    const matchBy = (ctx.params.match_by as ClientContact | undefined) ?? "phone";
    const create = !requiredExtra(ctx);
    out.workflows = [
      {
        value: {
          name: "client_from_lead",
          label: "Найти или создать клиента по заявке",
          trigger: { type: "on_create", entity: "lead" },
          steps: [
            {
              type: "function",
              params: { name: "clientFromLead", args: { id: "$record.id", matchBy, create } },
            },
          ],
        },
      },
    ];
    const sc = create ? leadHistoryScenario(leads, matchBy) : null;
    if (sc) out.acceptance = [{ value: sc }];
  }
  return out;
}
