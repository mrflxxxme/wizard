// Module «Кабинет посетителя» (specs/modules/modules.yaml#catalog visitor_cabinet): the login role `visitor` (code by
// e-mail or phone, open sign-up) and the page /me with «Мои записи», «Мои заявки», «Мои абонементы». The rows are the
// visitor's own by the data modules' permissions: each of them grants `$visitor` read with a rowFilter by the login
// contact ($user.email or $user.phone) — leads in its compile.ts, booking (B2-14) and packages (B2-18) in theirs — so
// G1 probes the row isolation (PC-visitor-<entity>-row). The page shows only the sections the role may read.
import type { ModuleManifest } from "@wizard/appspec";
import { can, columns, permOf, statusField } from "../screens/cabinet.js";
import { js, pascal } from "../screens/jsx.js";
import type { ModuleDefinition, ScreenContext } from "../types.js";

/** The visitor's sections: parameter, entity of the data module, title. */
export const VISITOR_SECTIONS = [
  { param: "show_bookings", entity: "booking", label: "Мои записи" },
  { param: "show_leads", entity: "lead", label: "Мои заявки" },
  { param: "show_packages", entity: "client_package", label: "Мои абонементы" },
] as const;

/** The user attribute the visitor's rows are matched by: the contact verified at login. */
export const visitorContact = (login: unknown): "email" | "phone" =>
  login === "phone_otp" ? "phone" : "email";

/** Status value a visitor may set himself (cancel a booking), when the data module allows the update. */
const CANCELLED = "cancelled";

export const visitorCabinetManifest: ModuleManifest = {
  id: "visitor_cabinet",
  version: 1,
  name: "Кабинет посетителя",
  summary: "Вход посетителя по коду: свои записи, заявки и абонементы, отмена и перенос",
  status: "ready",
  order: 95,
  origin: { kind: "v1_code", ref: "вход по коду runtime, ui-kit Login, CabinetLayout" },
  goals: ["self_service"],
  params: [
    {
      name: "login",
      label: "Вход посетителя",
      type: "enum",
      options: [
        { value: "email_otp", label: "Код на почту" },
        { value: "phone_otp", label: "Код по телефону" },
      ],
      default: "email_otp",
    },
    { name: "show_bookings", label: "Мои записи", type: "bool", default: true },
    { name: "show_leads", label: "Мои заявки", type: "bool", default: false },
    { name: "show_packages", label: "Мои абонементы", type: "bool", default: false },
  ],
  requires: [
    { module: "booking", reason: "раздел «Мои записи» показывает записи", when: { param: "show_bookings" } },
    { module: "leads", reason: "раздел «Мои заявки» показывает заявки", when: { param: "show_leads" } },
    {
      module: "packages",
      reason: "раздел «Мои абонементы» показывает абонементы",
      when: { param: "show_packages" },
    },
  ],
  provides: { roles: ["visitor"], routes: ["/me"] },
  fragments: {
    roles: [
      {
        value: {
          name: "visitor",
          label: "Клиент",
          access: "login",
          loginMethods: ["{{login}}"],
          selfSignup: true,
        },
      },
    ],
  },
  screens: [
    {
      id: "me",
      audience: "visitor",
      route: "/me",
      title: "Личный кабинет",
      roles: ["$visitor"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "Button", "EmptyState"],
      nav: true,
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-visitor_cabinet-1",
      goal: "self_service",
      title: "Посетитель входит по коду и видит только свои записи",
      withModules: ["booking", "catalog", "notify"],
      when: { param: "show_bookings" },
      steps: [
        { actor: "client", text: "Записывается, затем входит в кабинет по коду из письма" },
        { actor: "client", text: "Открывает «Мои записи»" },
      ],
      expect: [
        { kind: "record", text: "В списке его запись" },
        { kind: "denied", text: "Записей других посетителей нет" },
      ],
    },
    {
      id: "GS-visitor_cabinet-2",
      goal: "self_service",
      title: "Посетитель входит по коду и видит только свои заявки",
      withModules: ["leads"],
      when: { param: "show_leads" },
      steps: [
        {
          actor: "client",
          text: "Оставляет заявку с почтой, затем входит в кабинет по коду на эту почту",
        },
        { actor: "client", text: "Открывает «Мои заявки»" },
      ],
      expect: [
        { kind: "record", text: "В списке его заявка со статусом" },
        { kind: "denied", text: "Заявок других посетителей нет" },
      ],
    },
  ],
  tests: {
    matrix: [
      {
        name: "мои заявки, вход по почте",
        params: { show_bookings: false, show_leads: true },
        withModules: ["leads", "notify", "landing"],
      },
      {
        name: "мои заявки, вход по телефону",
        params: { login: "phone_otp", show_bookings: false, show_leads: true },
        withModules: ["leads", "notify"],
      },
      { name: "без разделов", params: { show_bookings: false } },
    ],
    gates: ["G0", "G1"],
  },
};

/** /me: a section per entity of the shown sections the visitor may read — his rows, a card, cancel when allowed. */
export function visitorScreen(ctx: ScreenContext): string {
  const role = ctx.roles[0] ?? "visitor";
  const shown = VISITOR_SECTIONS.filter(
    (s) => ctx.params[s.param] === true && can(ctx.spec, role, s.entity, "read"),
  );
  const parts: string[] = [];
  const sections: string[] = [];
  for (const s of shown) {
    const comp = `${pascal(s.entity)}Mine`;
    const st = statusField(ctx.spec, s.entity);
    const ro = new Set(permOf(ctx.spec, role, s.entity)?.readonlyFields ?? []);
    const cancel =
      st && can(ctx.spec, role, s.entity, "update") && !ro.has(st.name)
        ? (st.enum ?? []).find((o) => o.value === CANCELLED)
        : undefined;
    const actions = cancel
      ? `{ id: "cancel", label: "Отменить", tone: "danger", kind: "update", patch: { ${st?.name}: ${js(CANCELLED)} }, confirm: "Отменить запись?", visible: (r: Doc) => r.${st?.name} !== ${js(CANCELLED)} }`
      : "";
    parts.push(
      [
        `function ${comp}() {`,
        `  type Doc = ClientDoc<${js(s.entity)}>;`,
        "  const [selected, setSelected] = useState<string | null>(null);",
        "  return (",
        "    <>",
        `      <DataTable entity={${js(s.entity)}} columns={${js([...columns(ctx.spec, role, s.entity), "created_at"])}} defaultSort={{ field: "created_at", dir: "desc" }} onRowClick={(r: Doc) => setSelected(r.id)} emptyText="Здесь пока пусто" />`,
        "      {selected ? (",
        "        <>",
        `          <RecordCard entity={${js(s.entity)}} id={selected} actions={[${actions}]} />`,
        '          <Button variant="ghost" onClick={() => setSelected(null)}>Закрыть</Button>',
        "        </>",
        "      ) : null}",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );
    sections.push(`{ id: ${js(s.entity)}, label: ${js(s.label)}, content: <${comp} /> }`);
  }
  const body = shown.length
    ? `<CabinetLayout title="Личный кабинет" defaultSection={${js(shown[0]?.entity)}} sections={[${sections.join(", ")}]} />`
    : `<CabinetLayout title="Личный кабинет" sections={[{ id: "empty", label: "Кабинет", content: <EmptyState text="Здесь появятся ваши записи и заявки" /> }]} />`;
  const imports = shown.length ? "Button, CabinetLayout, DataTable, RecordCard" : "CabinetLayout, EmptyState";
  return [
    "// Generated by the module «Кабинет посетителя» (B2-16): the visitor's own rows by the data modules' rowFilter.",
    ...(shown.length ? ['import { type ClientDoc, useState } from "@wizard/sdk";'] : []),
    `import { ${imports} } from "@wizard/ui-kit";`,
    "",
    "export default function Me() {",
    "  return (",
    `    ${body}`,
    "  );",
    "}",
    "",
    ...parts.flatMap((p) => [p, ""]),
  ].join("\n");
}

export const visitorCabinetModule: ModuleDefinition = {
  manifest: visitorCabinetManifest,
  screens: { me: visitorScreen },
};
