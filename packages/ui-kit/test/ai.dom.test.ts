// @vitest-environment happy-dom
// M3-02 (ui-kit.yaml#components.RecordCard «заполнено ИИ», runtime.yaml#ai_actions): a RecordCard action kind=ai fills
// the target field and marks it «заполнено ИИ»; a user's edit clears the mark; the action is hidden without the
// update operation; refusals show the server's Russian message; generated text is rendered as text — an XSS payload
// never becomes markup; the sdk DataSource posts to /api/ai/:action.
import type { AppSpec, Entity } from "@wizard/appspec";
import { SdkClient } from "@wizard/sdk";
import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { type RecordAction, RecordCard, sdkDataSource, toRoleSpec, WzProvider } from "../src/index.js";
import { createMemoryDataSource, wzError } from "../src/testing/index.js";
import { click, type Rendered, render } from "./helpers/dom.js";

const XSS =
  '<img src=x onerror="window.__wzXss=1"><script>window.__wzXss=2</script>Кратко: доклад о внедрении.';

function aiSpec(): AppSpec {
  const spec = structuredClone(forum);
  const app = spec.entities.find((e) => e.name === "speaker_application") as Entity;
  app.fields.push({ name: "ai_summary", label: "Резюме ИИ", type: "text", maxLength: 1000 });
  spec.aiActions = [
    {
      name: "summarize_application",
      kind: "generate",
      input: { entity: "speaker_application", fields: ["topic", "abstract"] },
      output: { field: "ai_summary" },
      monthlyLimit: 50,
    },
  ];
  return spec;
}

const ACTIONS: RecordAction[] = [
  { id: "ai_summary", label: "Резюме ИИ", kind: "ai", ai: "summarize_application" },
];

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  delete (window as { __wzXss?: unknown }).__wzXss;
});

function setup(user = "u_moderator") {
  const spec = aiSpec();
  const f = forumFixture();
  const ds = createMemoryDataSource(spec, f.rows, {
    users: f.users,
    userId: user,
    aiActions: {
      summarize_application: { entity: "speaker_application", fill: () => ({ ai_summary: XSS }) },
    },
  });
  return { spec, ds };
}

const card = (spec: AppSpec, role: string, ds: ReturnType<typeof setup>["ds"]) =>
  render(
    h(RecordCard, {
      entity: "speaker_application",
      id: "app_001",
      fields: ["topic", "ai_summary"],
      actions: ACTIONS,
    }),
    { spec: toRoleSpec(spec, role), ds },
  );

describe("RecordCard: AI action button and «заполнено ИИ»", () => {
  test("button → the field is filled and marked «заполнено ИИ»; the text stays text (no img/script)", async () => {
    const { spec, ds } = setup();
    r = await card(spec, "moderator", ds);
    expect(r.$$("wz-recordcard-ai-ai_summary")).toHaveLength(0);
    await click(r.$("wz-recordcard-action-ai_summary"));
    expect(ds.calls.filter((c) => c.op === "ai")).toEqual([
      { op: "ai", entity: "speaker_application", name: "summarize_application", args: ["app_001"] },
    ]);
    const field = r.$("wz-recordcard-field-ai_summary");
    expect(field.textContent).toContain("Кратко: доклад о внедрении.");
    expect(field.textContent).toContain("<script>");
    expect(field.querySelector("img, script")).toBeNull();
    expect(r.container.querySelector("img, script")).toBeNull();
    expect((window as { __wzXss?: unknown }).__wzXss).toBeUndefined();
    const badge = r.$("wz-recordcard-ai-ai_summary");
    expect(badge.textContent).toBe("заполнено ИИ");
    expect(badge.dataset.tone).toBe("accent");
    expect(r.$$("wz-recordcard-ai-topic")).toHaveLength(0);
    expect(r.q('[role="status"]').textContent).toBe("Готово: поля заполнены ИИ");
  });

  test("a user's edit of the field clears the mark", async () => {
    const { spec, ds } = setup();
    ds.runAi("summarize_application", "speaker_application", "app_001");
    r = await card(spec, "moderator", ds);
    expect(r.$$("wz-recordcard-ai-ai_summary")).toHaveLength(1);
    await act(async () => {
      ds.update("speaker_application", "app_001", { ai_summary: "Своими словами" });
    });
    expect(r.$("wz-recordcard-field-ai_summary").textContent).toContain("Своими словами");
    expect(r.$$("wz-recordcard-ai-ai_summary")).toHaveLength(0);
  });

  test("hidden without update on the entity (participant reads nothing; speaker can update own only)", async () => {
    const { spec, ds } = setup("u_partner");
    const s = structuredClone(spec);
    s.permissions.push({ role: "partner", entity: "speaker_application", ops: ["read"] });
    const ds2 = createMemoryDataSource(s, forumFixture().rows, {
      users: forumFixture().users,
      userId: "u_partner",
    });
    r = await card(s, "partner", ds2);
    expect(r.$$("wz-recordcard-action-ai_summary")).toHaveLength(0);
    expect(ds.calls).toEqual([]);
  });

  test("a refusal shows the server's Russian message as an alert; nothing is marked", async () => {
    const { spec, ds } = setup();
    ds.failNext(
      "ai",
      wzError("AI_LIMIT_REACHED", { message: "Лимит ИИ-действий на этот месяц исчерпан", status: 429 }),
    );
    r = await card(spec, "moderator", ds);
    await click(r.$("wz-recordcard-action-ai_summary"));
    expect(r.q('[role="alert"]').textContent).toBe("Лимит ИИ-действий на этот месяц исчерпан");
    expect(r.$$("wz-recordcard-ai-ai_summary")).toHaveLength(0);
  });
});

describe("sdk DataSource: POST /api/ai/:action and `_aiFilled` from the record", () => {
  test("the button posts {entity, id}; the refetched record carries `_aiFilled` → badge", async () => {
    const spec = aiSpec();
    let filled = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://sys.test").pathname;
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (path === "/api/ai/summarize_application") {
        filled = true;
        return json({
          item: { id: "app_001", ai_summary: XSS, _aiFilled: ["ai_summary"] },
          filled: ["ai_summary"],
          skipped: [],
        });
      }
      if (path === "/api/data/speaker_application/app_001")
        return json({
          item: {
            id: "app_001",
            topic: "Тема",
            ai_summary: filled ? XSS : null,
            ...(filled ? { _aiFilled: ["ai_summary"] } : {}),
          },
        });
      if (path === "/api/auth/me")
        return json({ user: { id: "u1", role: "moderator", displayName: "М", isAdmin: false } });
      expect(init).toBeDefined();
      return new Response("{}", { status: 404 });
    });
    const client = new SdkClient({ fetch: fetch as never, realtime: false });
    const ds = sdkDataSource();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    const { SdkProvider } = await import("@wizard/sdk");
    await act(async () =>
      root.render(
        h(
          SdkProvider,
          { client },
          h(
            WzProvider,
            { spec: toRoleSpec(spec, "moderator"), applyTheme: false, dataSource: ds },
            h(RecordCard, {
              entity: "speaker_application",
              id: "app_001",
              fields: ["ai_summary"],
              actions: ACTIONS,
            }),
          ),
        ),
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="wz-recordcard-action-ai_summary"]')).not.toBeNull(),
    );
    await act(async () => {
      (container.querySelector('[data-testid="wz-recordcard-action-ai_summary"]') as HTMLElement).click();
    });
    const post = fetch.mock.calls.find(([u]) => String(u).includes("/api/ai/"));
    expect(post?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ entity: "speaker_application", id: "app_001" }),
    });
    expect(new Headers(post?.[1]?.headers).get("x-wizard-request")).toBe("1");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="wz-recordcard-ai-ai_summary"]')?.textContent).toBe(
        "заполнено ИИ",
      ),
    );
    expect(container.querySelector("img, script")).toBeNull();
    act(() => root.unmount());
    container.remove();
    client.close();
  });
});
