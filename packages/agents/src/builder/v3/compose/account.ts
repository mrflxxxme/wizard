// The client cabinet /me of a v3 site (V3-18): the sections of «Кабинет посетителя» the system has — the same data and
// permissions as its v2 page (@wizard/modules visitorScreen): a section per kind of records the module shows
// (show_bookings, show_leads, show_packages) that the visitor role may read, its fields (the v2 cabinet's columns),
// «Отменить» where the role may set the cancelled status itself. The rows are the visitor's by the data modules'
// rowFilter on the server; the page only asks for them (useMyRecords of the account patterns).
import { type AppSpec, resolveParams, type SystemPlan } from "@wizard/appspec";
import { can, columns, permOf, statusField, VISITOR_SECTIONS, visitorCabinetManifest } from "@wizard/modules";

/** The module «Кабинет посетителя». */
export const VISITOR_CABINET_MODULE = "visitor_cabinet";
/** The status a visitor may set himself (the v2 page's CANCELLED). */
const CANCELLED = "cancelled";

/** A section of the cabinet in the slot contract of the account patterns. */
export interface CabinetSection {
  id: string;
  entity: string;
  label: string;
  fields?: string[];
  cancel?: { field: string; value: string; label: string };
  empty: string;
}

const EMPTY: Readonly<Record<string, string>> = {
  booking: "Записей пока нет",
  lead: "Заявок пока нет",
  client_package: "Абонементов пока нет",
};
const CANCEL_LABEL: Readonly<Record<string, string>> = { booking: "Отменить запись" };

/** The cabinet of the plan: the visitor role and its sections; null — the plan has no «Кабинет посетителя». */
export function clientCabinet(
  spec: AppSpec,
  plan: Pick<SystemPlan, "modules">,
): { role: string; sections: CabinetSection[] } | null {
  const m = plan.modules.find((x) => x.id === VISITOR_CABINET_MODULE);
  if (!m) return null;
  const params = resolveParams(visitorCabinetManifest, m.params ?? {});
  const role =
    spec.roles.find((r) => r.selfSignup === true && r.access === "login")?.name ??
    spec.roles.find((r) => r.name === "visitor")?.name;
  if (!role) return null;
  const sections: CabinetSection[] = [];
  for (const s of VISITOR_SECTIONS) {
    if (params[s.param] !== true || !can(spec, role, s.entity, "read")) continue;
    const st = statusField(spec, s.entity);
    const ro = new Set(permOf(spec, role, s.entity)?.readonlyFields ?? []);
    const cancel =
      st && can(spec, role, s.entity, "update") && !ro.has(st.name)
        ? (st.enum ?? []).find((o) => o.value === CANCELLED)
        : undefined;
    const fields = columns(spec, role, s.entity);
    sections.push({
      id: s.entity,
      entity: s.entity,
      label: s.label,
      ...(fields.length ? { fields } : {}),
      ...(st && cancel
        ? { cancel: { field: st.name, value: cancel.value, label: CANCEL_LABEL[s.entity] ?? "Отменить" } }
        : {}),
      empty: EMPTY[s.entity] ?? "Здесь пока пусто",
    });
  }
  return { role, sections };
}
