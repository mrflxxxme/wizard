// compile.ts of «Сотрудники и роли» (manifest.hook): login roles staff, staff_2 … staff_5 from the plan's role list,
// their sections (sections_N; empty — every section) and permission checks «a role sees its sections, not the others»
// for the G1 probes. The engine expands `$staff` of a section module to the roles in scope (roleScope).
import type { ModuleFragments, Role } from "@wizard/appspec";
import { DRAFT_MANIFESTS } from "../draft.js";
import type { ModuleContext } from "../types.js";

/** Canonical role names by position in the plan's list (provides.roles). */
export const STAFF_ROLE_NAMES = ["staff", "staff_2", "staff_3", "staff_4", "staff_5"] as const;

/** Sections a staff role may be limited to: modules whose data staff work with. */
export const STAFF_SECTIONS = [
  { value: "leads", label: "Заявки" },
  { value: "catalog", label: "Каталог и прайс" },
  { value: "booking", label: "Запись" },
  { value: "client_card", label: "Клиенты" },
  { value: "deals", label: "Сделки" },
  { value: "packages", label: "Абонементы" },
  { value: "resources", label: "Учёт выдачи" },
  { value: "reports", label: "Отчёты" },
] as const;

type LoginMethod = NonNullable<Role["loginMethods"]>[number];

const LOGIN_LABELS: Readonly<Record<string, string>> = {
  email_otp: "код на почту",
  phone_otp: "код по телефону",
  telegram: "Telegram или код на почту",
};

export interface StaffRole {
  name: string;
  label: string;
  /** Section module ids; null — every section. */
  sections: readonly string[] | null;
}

/** Staff roles of the module's parameters (with defaults), in the plan's order. */
export function staffRoles(params: Readonly<Record<string, unknown>>): StaffRole[] {
  const labels = ((params.roles as string[] | undefined) ?? []).slice(0, STAFF_ROLE_NAMES.length);
  return labels.map((label, i) => {
    const list = (params[`sections_${i + 1}`] as string[] | undefined) ?? [];
    return { name: STAFF_ROLE_NAMES[i] as string, label, sections: list.length ? list : null };
  });
}

/** Names of the staff roles that see `module` (a section id or any other module — then every role). */
export function staffRolesFor(params: Readonly<Record<string, unknown>>, module: string): string[] {
  const isSection = STAFF_SECTIONS.some((s) => s.value === module);
  return staffRoles(params)
    .filter((r) => !isSection || r.sections === null || r.sections.includes(module))
    .map((r) => r.name);
}

/**
 * Login methods of the staff roles. Telegram login needs the client's own bot (connectors/telegram.yaml), which the
 * plan does not have, so the code on e-mail stays available until the bot is connected.
 */
export function staffLoginMethods(login: unknown): LoginMethod[] {
  if (login === "phone_otp") return ["phone_otp"];
  if (login === "telegram") return ["telegram", "email_otp"];
  return ["email_otp"];
}

/** Russian description of the login of a staff role (the staff screen). */
export const staffLoginLabel = (login: unknown): string => LOGIN_LABELS[String(login)] ?? "код на почту";

/** Russian names of the sections a role sees among the plan's modules. */
export function sectionLabels(role: StaffRole, present: ReadonlySet<string>): string[] {
  return STAFF_SECTIONS.filter(
    (s) => present.has(s.value) && (role.sections === null || role.sections.includes(s.value)),
  ).map((s) => s.label);
}

/** The main entity of a section module (its first provides.entities in the catalog). */
function sectionEntity(module: string): string | undefined {
  return DRAFT_MANIFESTS.find((m) => m.id === module)?.provides?.entities?.[0];
}

/**
 * Sections whose staff also read another section's records (they pick them in their own records): the staff of
 * «Запись по слотам» read the catalog's services (B2-14), so the catalog is not «hidden» from them.
 */
const READ_BY: Readonly<Record<string, readonly string[]>> = { catalog: ["booking"] };

export function compileStaff(ctx: ModuleContext): ModuleFragments {
  const roles = staffRoles(ctx.params);
  const loginMethods = staffLoginMethods(ctx.params.login);
  const acceptance: NonNullable<ModuleFragments["acceptance"]> = [];
  for (const r of roles)
    for (const s of STAFF_SECTIONS) {
      const entity = sectionEntity(s.value);
      if (!entity || !ctx.present.has(s.value)) continue;
      const allowed = r.sections === null || r.sections.includes(s.value);
      if (!allowed && (READ_BY[s.value] ?? []).some((m) => ctx.present.has(m) && r.sections?.includes(m)))
        continue;
      acceptance.push({
        value: {
          text: allowed
            ? `Роль «${r.label}» видит раздел «${s.label}»`
            : `Роль «${r.label}» не видит раздел «${s.label}»: он не входит в её разделы`,
          check: { type: "permission", role: r.name, entity, op: "read", expect: allowed ? "allow" : "deny" },
        },
      });
    }
  return {
    roles: roles.map((r) => ({
      value: {
        name: r.name,
        label: r.label,
        access: "login",
        loginMethods: [...loginMethods],
      } satisfies Role,
    })),
    acceptance,
  };
}
