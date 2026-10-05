// A small leads system (M2P live-eval regressions, harness v2 tests): spec with two pages and three functions, and the
// function examples of the SDK cheatsheet that implement them.
import { type AppSpec, applyOps, emptySpec } from "@wizard/appspec";
import { PROMPT_PARTS } from "../../src/builder/docs.js";

export function leadSpec(): AppSpec {
  const r = applyOps(
    emptySpec("Клиника"),
    [
      {
        op: "add_role",
        name: "admin",
        label: "Админ",
        access: "login",
        loginMethods: ["email_otp"],
        isAdmin: true,
      },
      { op: "add_role", name: "guest", label: "Гость", access: "public" },
      {
        op: "add_entity",
        name: "service",
        label: "Услуга",
        fields: [{ name: "name", label: "Название", type: "string", required: true }],
      },
      {
        op: "add_entity",
        name: "lead",
        label: "Заявка",
        fields: [
          { name: "name", label: "Имя", type: "string", required: true },
          { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic" },
          { name: "comment", label: "Комментарий", type: "text" },
          { name: "service", label: "Услуга", type: "ref", ref: { entity: "service" }, required: true },
          {
            name: "status",
            label: "Статус",
            type: "enum",
            required: true,
            enum: [
              { value: "new", label: "Новая" },
              { value: "done", label: "Обработана" },
            ],
          },
        ],
        indexes: [{ fields: ["status"] }],
        retention: { deleteAfterDays: 365 },
      },
      { op: "set_permission", role: "admin", entity: "lead", ops: ["read", "create", "update"] },
      { op: "set_permission", role: "admin", entity: "service", ops: ["read", "create", "update"] },
      { op: "set_permission", role: "guest", entity: "service", ops: ["read"] },
      {
        op: "add_function",
        name: "leadList",
        kind: "query",
        file: "functions/leadList.ts",
        roles: ["admin"],
      },
      {
        op: "add_function",
        name: "leadCreate",
        kind: "mutation",
        file: "functions/leadCreate.ts",
        public: true,
        roles: ["guest", "admin"],
      },
      {
        op: "add_function",
        name: "leadNotify",
        kind: "action",
        file: "functions/leadNotify.ts",
        roles: ["admin"],
      },
      { op: "add_page", route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest", "admin"] },
      {
        op: "add_page",
        route: "/leads/:id",
        title: "Заявка «№»",
        file: "ui/pages/lead-detail.tsx",
        roles: ["admin"],
      },
    ],
    0,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

/** The function examples of the SDK cheatsheet: `// functions/<name>.ts …` code blocks. */
export function cheatsheetFunctions(): [string, string][] {
  const out: [string, string][] = [];
  for (const m of PROMPT_PARTS.sdk.matchAll(/```ts\n\/\/ (functions\/\w+\.ts)[^\n]*\n([\s\S]*?)```/g))
    out.push([m[1] as string, m[2] as string]);
  return out;
}
