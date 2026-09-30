// Acceptance M0-09: role × entity × op matrix of the forum, generated from permissions, through createRuntimeApp().fetch.
import type { AppSpec, Entity, Permission } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceInfo } from "../src/index.js";
import {
  forumSpec,
  type Harness,
  harness,
  login,
  request,
  seedRow,
  seedUser,
  userIdOf,
  valueFor,
} from "./helpers.js";

const spec: AppSpec = forumSpec();
const HOST = "forum--draft.localhost:4100";
const consent = (() => {
  const c = complianceInfo(spec);
  return { policyVersion: c.policyVersion, textHash: c.consentTextHash };
})();

type Op =
  | "list"
  | "get"
  | "get_foreign"
  | "create"
  | "update"
  | "update_foreign"
  | "delete"
  | "delete_foreign";
interface Case {
  role: string;
  entity: string;
  op: Op;
  expected: number;
}

const perm = (role: string, entity: string): Permission | undefined =>
  spec.permissions.find((p) => p.role === role && p.entity === entity);
const has = (p: Permission | undefined, op: "read" | "create" | "update" | "delete") =>
  p?.ops.includes(op) === true;
const filterApplies = (p: Permission | undefined, op: "read" | "create" | "update" | "delete") =>
  p?.rowFilter !== undefined &&
  Object.keys(p.rowFilter).length > 0 &&
  ((p as Permission & { rowFilterOps?: string[] }).rowFilterOps ?? p.ops).includes(op);
const entityOf = (name: string) => spec.entities.find((e) => e.name === name) as Entity;
const hasPii = (e: Entity) => e.fields.some((f) => f.pii !== undefined && f.pii !== "none");
const isAdmin = (role: string) => spec.roles.some((r) => r.name === role && r.isAdmin === true);

/** Required fields the role cannot write and that have no default → create is rejected with 422. */
function createBlocked(p: Permission, e: Entity): boolean {
  const forced = filterApplies(p, "create") ? Object.keys(p.rowFilter ?? {}) : [];
  return e.fields.some(
    (f) =>
      f.required &&
      f.default === undefined &&
      f.type !== "qr_token" &&
      !forced.includes(f.name) &&
      ((p.readonlyFields ?? []).includes(f.name) ||
        (p.hiddenFields ?? []).includes(f.name) ||
        (f.type === "ref" && f.ref?.entity !== "users" && !has(perm(p.role, f.ref?.entity ?? ""), "read"))),
  );
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const r of spec.roles) {
    for (const e of spec.entities) {
      const p = perm(r.name, e.name);
      const add = (op: Op, expected: number) => out.push({ role: r.name, entity: e.name, op, expected });
      add("list", has(p, "read") ? 200 : 403);
      add("get", has(p, "read") ? 200 : 403);
      if (has(p, "read") && filterApplies(p, "read")) add("get_foreign", 404);
      add("create", !has(p, "create") ? 403 : createBlocked(p as Permission, e) ? 422 : 201);
      add("update", has(p, "update") ? 200 : 403);
      if (has(p, "update") && filterApplies(p, "update")) add("update_foreign", 404);
      add("delete", has(p, "delete") ? 204 : 403);
      if (has(p, "delete") && filterApplies(p, "delete")) add("delete_foreign", 404);
    }
  }
  return out;
}

let h: Harness;
let schema = "";
let foreignUser = "";
const cookies: Record<string, string | null> = {};
const users: Record<string, string> = {};

beforeAll(async () => {
  h = await harness();
  ({ schema } = await h.system("forum", spec));
  for (const r of spec.roles) {
    if (r.access === "login") {
      cookies[r.name] = await login(h.rt, HOST, r.name);
      users[r.name] = await userIdOf(h.sql, schema, r.name);
    } else cookies[r.name] = null;
  }
  foreignUser = await seedUser(h.sql, schema, "participant");
});

afterAll(async () => {
  await h?.close();
});

/** rowFilter values of the role applied to a seeded row ($user.id → the role's user, or a foreign user). */
function overrides(role: string, p: Permission | undefined, own: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(p?.rowFilter ?? {})) {
    out[col] = v === "$user.id" ? (own ? (users[role] ?? foreignUser) : foreignUser) : v;
  }
  return out;
}

async function seedFor(role: string, entity: string, own = true): Promise<string> {
  return seedRow(
    h.sql,
    schema,
    spec,
    entity,
    overrides(role, perm(role, entity), own),
    users[role] ?? foreignUser,
  );
}

async function createBody(role: string, e: Entity): Promise<Record<string, unknown>> {
  const p = perm(role, e.name) as Permission;
  const forced = filterApplies(p, "create") ? Object.keys(p.rowFilter ?? {}) : [];
  const body: Record<string, unknown> = {};
  for (const f of e.fields) {
    if (!f.required || forced.includes(f.name) || f.type === "qr_token") continue;
    if ((p.readonlyFields ?? []).includes(f.name) || (p.hiddenFields ?? []).includes(f.name)) continue;
    if (f.type === "ref") {
      const target = f.ref?.entity ?? "";
      body[f.name] = target === "users" ? (users[role] ?? foreignUser) : await seedFor(role, target);
    } else body[f.name] = valueFor(f);
  }
  if (hasPii(e) && !isAdmin(role)) body._consent = consent;
  return body;
}

function updateBody(role: string, e: Entity): Record<string, unknown> {
  const p = perm(role, e.name) as Permission;
  const blocked = new Set([
    ...(p.readonlyFields ?? []),
    ...(p.hiddenFields ?? []),
    ...Object.keys(p.rowFilter ?? {}),
  ]);
  const f = e.fields.find((x) => !blocked.has(x.name) && !["ref", "qr_token", "json"].includes(x.type));
  const body: Record<string, unknown> = f ? { [f.name]: valueFor(f) } : {};
  if (hasPii(e) && !isAdmin(role)) body._consent = consent;
  return body;
}

async function run(c: Case): Promise<Response> {
  const e = entityOf(c.entity);
  const cookie = cookies[c.role];
  const p = perm(c.role, c.entity);
  const path = `/api/data/${c.entity}`;
  switch (c.op) {
    case "list": {
      const own = await seedFor(c.role, c.entity);
      const res = await h.rt.fetch(request("GET", HOST, path, { cookie }));
      if (res.status === 200 && filterApplies(p, "read")) {
        const body = (await res.clone().json()) as { items: Record<string, unknown>[] };
        const expected = overrides(c.role, p, true);
        expect(body.items.some((i) => i.id === own)).toBe(true);
        for (const item of body.items) for (const [k, v] of Object.entries(expected)) expect(item[k]).toBe(v);
      }
      return res;
    }
    case "get":
    case "get_foreign": {
      const id = await seedFor(c.role, c.entity, c.op === "get");
      const res = await h.rt.fetch(request("GET", HOST, `${path}/${id}`, { cookie }));
      if (res.status === 200) {
        const { item } = (await res.clone().json()) as { item: Record<string, unknown> };
        for (const hidden of p?.hiddenFields ?? []) expect(Object.hasOwn(item, hidden)).toBe(false);
        expect(item.id).toBe(id);
      }
      return res;
    }
    case "create":
      return h.rt.fetch(
        request("POST", HOST, path, {
          cookie,
          body: p && has(p, "create") ? await createBody(c.role, e) : {},
        }),
      );
    case "update":
    case "update_foreign": {
      const id = await seedFor(c.role, c.entity, c.op === "update");
      const body = p && has(p, "update") ? updateBody(c.role, e) : {};
      return h.rt.fetch(request("PATCH", HOST, `${path}/${id}`, { cookie, body }));
    }
    case "delete":
    case "delete_foreign": {
      const id = await seedFor(c.role, c.entity, c.op === "delete");
      return h.rt.fetch(request("DELETE", HOST, `${path}/${id}`, { cookie }));
    }
  }
}

describe("forum permission matrix (generated from permissions)", () => {
  const all = cases();
  it("covers every role × entity", () => {
    expect(all.filter((c) => c.op === "list")).toHaveLength(spec.roles.length * spec.entities.length);
  });
  it.each(all.map((c) => [`${c.role} ${c.op} ${c.entity} → ${c.expected}`, c] as const))(
    "%s",
    async (_n, c) => {
      const res = await run(c);
      const text = await res.text();
      expect(res.status, text).toBe(c.expected);
    },
  );
});
