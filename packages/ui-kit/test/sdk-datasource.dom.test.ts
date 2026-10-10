// @vitest-environment happy-dom
// sdkDataSource over @wizard/sdk hooks (ui-kit.yaml#data_binding.sdk_mapping) against a fake runtime fetch.
import { SdkClient, SdkProvider } from "@wizard/sdk";
import { createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { forum } from "../demo/fixtures.js";
import {
  type AsyncResult,
  type sdkDataSource,
  toRoleSpec,
  toSdkListOptions,
  useDataSource,
  WzProvider,
} from "../src/index.js";
import { flush, type Rendered, render } from "./helpers/dom.js";

type Call = { method: string; url: URL; body: unknown; headers: Record<string, string> };

function fakeRuntime(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input, "http://forum--draft.localhost"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    client: new SdkClient({ fetch, realtime: false, consent: { policyVersion: "1", textHash: "h" } }),
  };
}

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});

function mount(client: SdkClient, role: string, child: ReactNode) {
  const spec = toRoleSpec(forum, role);
  return render(h(SdkProvider, { client }, h(WzProvider, { spec, applyTheme: false }, child)));
}

describe("sdkDataSource", () => {
  test("ListQuery → sdk options: sort '-field', limit ≤ 100, search → q over the role's fields (V3-18)", () => {
    expect(
      toSdkListOptions({
        filter: { status: "new" },
        sort: { field: "created_at", dir: "desc" },
        page: 2,
        pageSize: 25,
        search: " Ив ",
      }),
    ).toEqual({
      filter: { status: "new" },
      sort: "-created_at",
      page: 2,
      limit: 25,
      search: "Ив",
    });
    expect(toSdkListOptions({ pageSize: 500, search: "  " })).toEqual({ limit: 100 });
  });

  test("WzProvider defaults to sdkDataSource; useList hits /api/data with the mapped query", async () => {
    const rt = fakeRuntime(() => ({
      status: 200,
      body: { items: [{ id: "a1", full_name: "Иван" }], total: 1, page: 1, limit: 25, hasMore: false },
    }));
    const seen: AsyncResult<{ items: unknown[]; total: number }>[] = [];
    function Probe() {
      seen.push(
        useDataSource().useList("speaker_application", {
          search: "Ив",
          sort: { field: "created_at", dir: "desc" },
          pageSize: 25,
        }),
      );
      return null;
    }
    r = await mount(rt.client, "organizer", h(Probe));
    await flush(20);
    const get = rt.calls.find((c) => c.url.pathname === "/api/data/speaker_application");
    expect(get?.url.searchParams.get("q")).toBe("Ив");
    expect(get?.url.searchParams.get("filter[full_name][contains]")).toBeNull();
    expect(get?.url.searchParams.get("sort")).toBe("-created_at");
    expect(get?.url.searchParams.get("limit")).toBe("25");
    expect(seen.at(-1)?.data).toEqual({ items: [{ id: "a1", full_name: "Иван" }], total: 1 });
  });

  test("WizardError → WzError with fields; create sends _consent when opts.consent", async () => {
    const rt = fakeRuntime((c) =>
      c.method === "POST"
        ? {
            status: 422,
            body: {
              error: {
                code: "VALIDATION_FAILED",
                message: "Проверьте заполнение полей",
                details: { fields: [{ field: "email", code: "FORMAT", message: "Неверный email" }] },
                requestId: "rq1",
              },
            },
          }
        : { status: 200, body: { items: [], total: 0, page: 1, limit: 20, hasMore: false } },
    );
    let create: ((v: Record<string, unknown>, o?: { consent?: true }) => Promise<unknown>) | undefined;
    function Probe() {
      create = useDataSource().useCreate("speaker_application").mutate;
      return null;
    }
    r = await mount(rt.client, "speaker", h(Probe));
    await expect(create?.({ email: "x" }, { consent: true })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
      fields: [{ field: "email", code: "FORMAT", message: "Неверный email" }],
    });
    const post = rt.calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ email: "x", _consent: { policyVersion: "1", textHash: "h" } });
    expect(post?.headers["X-Wizard-Request"]).toBe("1");
  });

  test("useAuth: OTP start/verify go to /api/auth/* with X-Wizard-Request", async () => {
    const rt = fakeRuntime((c) =>
      c.url.pathname === "/api/auth/otp/start"
        ? { status: 200, body: { challengeId: "ch1" } }
        : c.url.pathname === "/api/auth/otp/verify"
          ? {
              status: 200,
              body: { user: { id: "u1", role: "participant", displayName: "Иван", isAdmin: false } },
            }
          : c.url.pathname === "/api/auth/me"
            ? {
                status: 200,
                body: { user: { id: "u1", role: "participant", displayName: "Иван", isAdmin: false } },
              }
            : { status: 404, body: { error: { code: "NOT_FOUND", message: "нет" } } },
    );
    let auth: ReturnType<ReturnType<typeof sdkDataSource>["useAuth"]> | undefined;
    function Probe() {
      auth = useDataSource().useAuth();
      return null;
    }
    r = await mount(rt.client, "participant", h(Probe));
    expect(await auth?.start("phone", "+79001234510")).toEqual({ challengeId: "ch1" });
    expect((await auth?.verify("ch1", "123456"))?.role).toBe("participant");
    const start = rt.calls.find((c) => c.url.pathname === "/api/auth/otp/start");
    expect(start?.body).toEqual({ channel: "phone", destination: "+79001234510" });
    expect(start?.headers["X-Wizard-Request"]).toBe("1");
  });
});
