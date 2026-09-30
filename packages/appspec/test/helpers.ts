import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AppSpec } from "../src/index.js";
import { validateSpec } from "../src/index.js";
import forumFixture from "./fixtures/forum.json" with { type: "json" };

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** JSON Schema validator (test-only): specs/appspec/appspec.schema.json via ajv draft 2020-12. */
export function jsonSchemaValidator(): (data: unknown) => boolean {
  const schema = JSON.parse(readFileSync(`${repoRoot}specs/appspec/appspec.schema.json`, "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  return (data) => validate(data) === true;
}

/** Forum spec: specs/appspec/examples/forum.json when present and valid, else the local fixture. */
export function forumSpec(): AppSpec {
  const shared = `${repoRoot}specs/appspec/examples/forum.json`;
  if (existsSync(shared)) {
    const r = validateSpec(JSON.parse(readFileSync(shared, "utf8")));
    if (r.ok) return r.spec;
  }
  const r = validateSpec(structuredClone(forumFixture));
  if (!r.ok) throw new Error(`forum fixture invalid: ${JSON.stringify(r.errors)}`);
  return r.spec;
}

/** Small valid spec used by op and semantic tests. */
export function miniSpec(): AppSpec {
  return {
    specVersion: "1",
    app: { name: "Мини", locale: "ru" },
    entities: [
      {
        name: "task",
        label: "Задача",
        ownerField: "owner",
        fields: [
          { name: "title", label: "Название", type: "string", required: true },
          { name: "owner", label: "Владелец", type: "ref", ref: { entity: "users" } },
          {
            name: "state",
            label: "Статус",
            type: "enum",
            enum: [
              { value: "todo", label: "К работе" },
              { value: "done", label: "Готово" },
            ],
          },
          { name: "points", label: "Баллы", type: "int", min: 0, max: 100 },
          { name: "email", label: "Почта", type: "email", pii: "basic" },
        ],
      },
      {
        name: "comment",
        label: "Комментарий",
        fields: [
          {
            name: "task",
            label: "Задача",
            type: "ref",
            ref: { entity: "task", onDelete: "cascade" },
            required: true,
          },
          { name: "body", label: "Текст", type: "text", required: true },
        ],
      },
    ],
    roles: [
      { name: "guest", label: "Гость", access: "public" },
      { name: "worker", label: "Сотрудник", access: "login", loginMethods: ["email_otp"] },
    ],
    permissions: [
      { role: "guest", entity: "task", ops: ["read"] },
      { role: "worker", entity: "task", ops: ["read", "create", "update"], rowFilter: { owner: "$user.id" } },
      { role: "worker", entity: "comment", ops: ["read", "create"] },
    ],
    workflows: [{ name: "wf", trigger: { type: "on_create", entity: "task" }, steps: [{ type: "notify" }] }],
    integrations: [
      { name: "mail", connector: "email", config: { from: "a@b.ru" }, secretRefs: ["secret://smtp"] },
    ],
    functions: [{ name: "stats", kind: "query", file: "functions/stats.ts", roles: ["worker"] }],
    pages: [{ route: "/", title: "Главная", file: "ui/Home.tsx", roles: ["guest"] }],
    aiActions: [],
    acceptance: [
      {
        id: "AC1",
        text: "Гость читает задачи",
        check: { type: "permission", role: "guest", entity: "task", op: "read", expect: "allow" },
      },
    ],
    compliance: { consentText: "Согласен" },
  };
}
