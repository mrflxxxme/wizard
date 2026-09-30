import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { generateTypes } from "../src/codegen/index.js";
import { entityIndexes } from "../src/host/indexes.js";
import { loadForum } from "./helpers/app.js";

const forum = loadForum();

function entityBlock(out: string, name: string): string {
  const start = out.indexOf(`    ${name}: {`);
  const end = out.indexOf("\n    };", start);
  return out.slice(start, end);
}

describe("generateTypes (sdk.md §4)", () => {
  const out = generateTypes(forum);

  test("snapshot for forum.json", async () => {
    await expect(out).toMatchFileSnapshot("./__snapshots__/forum.wizard.d.ts");
  });

  test("augments the five registries of @wizard/sdk", () => {
    expect(out).toContain('declare module "@wizard/sdk" {');
    for (const i of ["Roles", "Entities", "Functions", "Connectors", "Payments"]) {
      expect(out).toMatch(new RegExp(`\\n  interface ${i} \\{`));
    }
    expect(out).toMatch(/^import type \{[^}]*\bId\b[^}]*\bRange\b[^}]*\} from "@wizard\/sdk";$/m);
    expect(out).toContain('registerTicket: typeof import("../functions/registerTicket").default;');
    expect(out).toContain("telegram: TelegramConnector;");
    expect(out).toMatch(/interface Payments \{\n\s+yookassa: "ticket";/);
  });

  test("field mapping: optional → T | null in doc, optional/default in insert, hidden → optional in clientDoc", () => {
    const t = entityBlock(out, "ticket");
    expect(t).toContain('/** Статус */ status: "pending_payment" | "paid" | "issued" | "canceled" | "refunded";');
    expect(t).toContain("/** Телефон */ holder_phone: string | null;");
    expect(t).toContain('/** Поток */ stream: Id<"stream">;');
    expect(t).toContain('/** Владелец */ holder_user: Id<"users">;');
    expect(t).toMatch(/insert: \{[^}]*\n\s+status\?: "pending_payment"/);
    expect(t).toMatch(/insert: \{[^}]*\n\s+qr_token\?: string \| null;/);
    expect(t).toMatch(/clientDoc: \{[^}]*\n\s+holder_name\?: string;/);
    expect(t).toMatch(/clientDoc: \{[^}]*\n\s+status: "pending_payment"/);
    expect(entityBlock(out, "partner_quota")).toContain('unique: "promo_code";');
    expect(entityBlock(out, "stream")).toContain("unique: never;");
  });

  test("where is a union of index prefixes without `{}`", () => {
    const where = entityBlock(out, "ticket").split("where:")[1] ?? "";
    const members = where.split("\n").filter((l) => l.trim().startsWith("|"));
    // [stream,status,created_at] + [ticket_type,status,created_at] = 6, id, created_at, holder_user
    // (ref stream/ticket_type prefixes are shared with the declared indexes).
    expect(members).toHaveLength(9);
    expect(where).not.toMatch(/\|\s*\{\s*\}/);
    expect(where).toContain("created_at: string | Range<string>");
  });

  test("json fields import Json; created_by ownerField and unique indexes are indexed", () => {
    const spec: AppSpec = {
      ...forum,
      entities: [
        {
          name: "note",
          label: "Заметка",
          fields: [
            { name: "body", label: "Текст", type: "json" },
            { name: "code", label: "Код", type: "string", required: true },
          ],
          indexes: [{ fields: ["code"], unique: true }],
          ownerField: "created_by",
        },
      ],
      permissions: [],
      functions: [],
      integrations: [],
    };
    const g = generateTypes(spec);
    expect(g).toMatch(/import type \{ Id, Json, Range \}/);
    expect(g).toContain("body: Json | null;");
    expect(g).toContain('unique: "code";');
    expect(g).toContain('created_by: Id<"users"> | null;');
    expect(g).toMatch(/interface Payments \{\}/);
    expect(entityIndexes(spec.entities[0] as AppSpec["entities"][number])).toEqual([
      ["code"],
      ["id"],
      ["created_at"],
      ["created_by"],
    ]);
  });
});
