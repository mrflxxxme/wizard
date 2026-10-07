// @vitest-environment happy-dom
// B2-28: StatusBoard over the SDK without live updates (no event stream — G1 serves /api/events as 503): after its own
// move the board re-reads its columns, so the card stays in the new column instead of jumping back to the old one.
import { SdkClient, SdkProvider } from "@wizard/sdk";
import { createElement as h } from "react";
import { afterEach, expect, test } from "vitest";
import { studio } from "../demo/fixtures.js";
import { StatusBoard, toRoleSpec, WzProvider } from "../src/index.js";
import { click, flush, type Rendered, render } from "./helpers/dom.js";

type Lead = { id: string; name: string; service: string };

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});

test("a moved card stays in its new column: the board re-reads the lists after the write", async () => {
  const rows: Lead[] = [
    { id: "l1", name: "Пример: Анна", service: "basic" },
    { id: "l2", name: "Пример: Борис", service: "basic" },
  ];
  const gets: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://studio--draft.localhost");
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if ((init?.method ?? "GET") === "PATCH") {
      const row = rows.find((x) => url.pathname.endsWith(`/${x.id}`));
      Object.assign(row ?? {}, JSON.parse(String(init?.body ?? "{}")) as Partial<Lead>);
      return json(200, { item: row });
    }
    gets.push(url.search);
    const service = url.searchParams.get("filter[service]");
    const items = rows.filter((x) => !service || x.service === service);
    return json(200, { items, total: items.length, page: 1, limit: 50, hasMore: false });
  };
  const client = new SdkClient({ fetch, realtime: false, consent: { policyVersion: "1", textHash: "h" } });
  r = await render(
    h(
      SdkProvider,
      { client },
      h(
        WzProvider,
        { spec: toRoleSpec(studio, "owner"), applyTheme: false },
        h(StatusBoard<Lead>, {
          entity: "lead",
          statusField: "service",
          card: (x: Lead) => ({ title: x.name }),
        }),
      ),
    ),
  );
  await flush(20);
  const cards = (v: string) =>
    [
      ...(r as Rendered)
        .$(`wz-statusboard-column-${v}`)
        .querySelectorAll('[data-testid="wz-statusboard-card"]'),
    ].map((c) => c.textContent ?? "");
  expect(cards("basic")).toHaveLength(2);
  const before = gets.length;

  const card = (r as Rendered)
    .$("wz-statusboard-column-basic")
    .querySelector('[data-testid="wz-statusboard-card"]');
  await click(card?.querySelector("button[aria-expanded]") as Element);
  await click(card?.querySelector('[data-testid="wz-statusboard-move-extended"]') as Element);
  await flush(20);

  // Both columns asked the runtime again, and the card is where the server now has it.
  expect(gets.length).toBeGreaterThanOrEqual(before + 2);
  expect(rows[0]?.service).toBe("extended");
  expect(cards("extended")).toEqual([expect.stringContaining("Анна")]);
  expect(cards("basic")).toEqual([expect.stringContaining("Борис")]);
});
