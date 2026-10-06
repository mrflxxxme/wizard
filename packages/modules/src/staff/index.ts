// Module «Сотрудники и роли» (specs/modules/modules.yaml#catalog staff): login roles of the staff with access by
// sections, the owner's page «Сотрудники и роли» with the roles and the invitation (the runtime page /_wizard/team over
// POST /api/admin/invite: only isAdmin roles invite, staff roles are closed to self sign-up). «Видит только своё»
// (see_only_own) is read by the modules with an assignee through allParams.staff.
import type { ModuleManifest, ParamSpec } from "@wizard/appspec";
import { jsxEl } from "../screens/jsx.js";
import type { ModuleDefinition, ScreenContext } from "../types.js";
import {
  compileStaff,
  STAFF_SECTIONS,
  sectionLabels,
  staffLoginLabel,
  staffRoles,
  staffRolesFor,
} from "./compile.js";

/** The runtime page of invitations (isAdmin only). */
export const TEAM_PAGE = "/_wizard/team";

const sectionsParam = (n: number): ParamSpec => ({
  name: `sections_${n}`,
  label: `Разделы роли ${n}`,
  type: "enum_list",
  options: STAFF_SECTIONS.map((s) => ({ ...s })),
  default: [],
  description: "Пусто — все разделы системы",
});

export const staffManifest: ModuleManifest = {
  id: "staff",
  version: 1,
  name: "Сотрудники и роли",
  summary: "Роли сотрудников с доступом по разделам, приглашение по почте или телефону, «видит только своё»",
  status: "ready",
  order: 8,
  origin: {
    kind: "v1_code",
    ref: "роли и права AppSpec, приглашения runtime (POST /api/admin/invite, страница /_wizard/team)",
  },
  goals: ["team_work"],
  params: [
    {
      name: "roles",
      label: "Роли сотрудников",
      type: "string_list",
      maxItems: 5,
      maxLength: 40,
      default: ["Сотрудник"],
      description:
        "Роль 1 — staff, роль 2 — staff_2 … роль 5 — staff_5; разделы роли N — параметр sections_N",
    },
    sectionsParam(1),
    sectionsParam(2),
    sectionsParam(3),
    sectionsParam(4),
    sectionsParam(5),
    {
      name: "see_only_own",
      label: "Сотрудник видит только своё",
      type: "bool",
      default: false,
      description: "Учитывают модули с ответственным (специалист записи, ответственный сделки)",
    },
    {
      name: "login",
      label: "Вход сотрудников",
      type: "enum",
      options: [
        { value: "email_otp", label: "Код на почту" },
        { value: "phone_otp", label: "Код по телефону" },
        { value: "telegram", label: "Telegram" },
      ],
      default: "email_otp",
    },
  ],
  provides: { roles: ["staff", "staff_2", "staff_3", "staff_4", "staff_5"], routes: ["/cabinet/staff"] },
  hook: true,
  fragments: {},
  screens: [
    {
      id: "staff",
      audience: "cabinet",
      route: "/cabinet/staff",
      title: "Сотрудники и роли",
      roles: ["$owner"],
      components: ["CabinetLayout", "Features", "Button"],
      nav: true,
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-staff-1",
      goal: "team_work",
      title: "Приглашённый сотрудник входит и видит свой кабинет без настроек владельца",
      steps: [
        { actor: "owner", text: "Открывает «Сотрудники и роли» и приглашает сотрудника по почте" },
        { actor: "staff", text: "Входит по коду из письма" },
      ],
      expect: [
        { kind: "page_text", text: "Сотрудник видит рабочие разделы" },
        { kind: "denied", text: "Раздел «Сотрудники и роли» недоступен" },
      ],
    },
    {
      id: "GS-staff-2",
      goal: "team_work",
      title: "Сотрудник роли с ограниченными разделами не видит чужой раздел",
      when: { param: "sections_1" },
      steps: [
        { actor: "staff", text: "Входит под ролью 1 и открывает кабинет" },
        { actor: "staff", text: "Открывает адрес раздела, которого нет в его роли" },
      ],
      expect: [
        { kind: "page_text", text: "В кабинете только разделы его роли" },
        { kind: "denied", text: "Данные чужого раздела недоступны" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "одна роль, все разделы", params: {}, withModules: ["leads", "notify"] },
      {
        name: "две роли с разными разделами",
        params: { roles: ["Администратор", "Мастер"], sections_1: ["leads"], sections_2: ["booking"] },
        withModules: ["leads", "notify", "landing"],
      },
      {
        name: "пять ролей, вход по телефону, видит только своё",
        params: {
          roles: ["Администратор", "Мастер", "Менеджер", "Бухгалтер", "Стажёр"],
          login: "phone_otp",
          see_only_own: true,
        },
        withModules: ["leads", "notify"],
      },
      { name: "вход через Telegram", params: { login: "telegram" }, withModules: ["leads", "notify"] },
    ],
    gates: ["G0", "G1"],
  },
};

/** «Сотрудники и роли» of the owner: every role with its sections and login, the button to the invitation page. */
export function staffScreen(ctx: ScreenContext): string {
  const login = staffLoginLabel(ctx.params.login);
  const items = staffRoles(ctx.params).map((r) => {
    const sections = sectionLabels(r, ctx.present);
    const sees =
      r.sections === null
        ? "все разделы"
        : sections.length
          ? sections.join(", ")
          : "разделов этой роли пока нет в системе";
    return { title: r.label, text: `Видит: ${sees}. Вход: ${login}.` };
  });
  const own = ctx.params.see_only_own === true;
  const intro = own
    ? "Сотрудник видит только свои записи и сделки — те, где он ответственный."
    : "Сотрудник видит все записи своих разделов.";
  const roles = [
    jsxEl("Features", [
      ["title", "Роли сотрудников"],
      ["intro", intro],
      ["items", items],
      ["variant", "grid", "lit"],
      ["columns", 2],
    ]),
    `<Button variant="primary" href=${JSON.stringify(TEAM_PAGE)}>Пригласить сотрудника</Button>`,
  ];
  return [
    "// Generated by the module «Сотрудники и роли» (B2-16): staff roles, their sections and the invitation.",
    'import { Button, CabinetLayout, Features } from "@wizard/ui-kit";',
    "",
    "export default function Staff() {",
    "  return (",
    `    <CabinetLayout title="Сотрудники и роли" defaultSection="roles" sections={[{ id: "roles", label: "Роли", content: (`,
    "      <>",
    ...roles.map((b) => `        ${b}`),
    "      </>",
    "    ) }]} />",
    "  );",
    "}",
    "",
  ].join("\n");
}

export const staffModule: ModuleDefinition = {
  manifest: staffManifest,
  compile: compileStaff,
  screens: { staff: staffScreen },
  roleScope: (ctx, module) => staffRolesFor(ctx.params, module),
  warnings: (ctx) =>
    ctx.params.login === "telegram"
      ? [
          "Вход сотрудников через Telegram заработает после подключения своего бота; до этого сотрудники входят по коду на почту",
        ]
      : [],
};
