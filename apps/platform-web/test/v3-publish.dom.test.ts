// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
// V3-19 (DOM, API doubles): the publication of a built v3 system on the canvas. Only the server's publishBlockers stop
// it (a failed G2 of the build before the owner gave the operator's data does not); the operator's data is asked in the
// chat — checked in words before the request, saved as S10 saves it (expectedVersion = draftRevision), a stale version
// said in words; «Опубликовать» posts the revision publishTarget names and hands the run to the canvas, a refusal shows
// the server's text; the publish run shows its step, its result or its failure; a published system gives its site and
// the owner's cabinet; the draft cabinet opens a preview sign-in as the owner; not the owner — no button. On the
// canvas: a ready v3 system shows the card and the settings link, the publish run is followed to «Опубликована».
import { briefDiagrams, systemBriefSchema } from "@wizard/appspec";
import { act, type ComponentProps, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { GateReport, RunEvent, System, SystemView } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { ru } from "../src/i18n/ru.js";
import { initialRunState, type RunState } from "../src/run/reducer.js";
import { Canvas } from "../src/screens/canvas/Canvas.js";
import {
  operatorProblem,
  ownerCabinetUrl,
  publishRu,
  publishRunState,
  V3PublishCard,
  v3PublishModel,
} from "../src/screens/v3/publish/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "99999999-9999-4999-8999-999999999999";
const ORG = "00000000-0000-0000-0000-000000000001";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROD = "http://dental.localhost:4100/";

const system = (over: Partial<System> = {}): System => ({
  id: SYS,
  orgId: ORG,
  slug: "dental",
  name: "Стоматология",
  stage: "ready",
  draftRevision: 7,
  previewRevision: 7,
  prodRevision: null,
  prodUrl: null,
  createdAt: "2026-10-09T10:00:00Z",
  ...over,
});
const sysView = (over: Partial<System> = {}, codes: string[] = []): SystemView => ({
  system: system(over),
  messages: [],
  pendingQuestions: [],
  activeRunId: null,
  publishBlockers: codes,
});
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent => ({
  runId: RUN,
  seq,
  ts: "2026-10-09T10:00:00Z",
  type,
  payload,
});
const report = (level: "G0" | "G1" | "G2", passed: boolean): GateReport =>
  ({ level, passed, checks: [], specVersion: 7 }) as unknown as GateReport;
const PUBLISH_START = [ev(1, "run_started", { kind: "publish" })];
const run = (events: RunEvent[]): RunState => publishRunState(events) ?? initialRunState();

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}
async function mount(api: Partial<ApiClient>, node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      h(
        PlatformProvider,
        { api: { getOrgSettings: async () => ({}), ...api } as ApiClient } as ComponentProps<
          typeof PlatformProvider
        >,
        node,
      ),
    ),
  );
  await flush();
}
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const $$ = (id: string) => [...(container?.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`) ?? [])];
const click = async (id: string) => {
  await act(async () => $(id)?.click());
  await flush();
};
const type = async (id: string, value: string) => {
  const el = $(id) as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async (id: string) => {
  await act(async () => {
    $(id)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
};

/** API of a built system: the latest revision 7, gates as given. */
const builtApi = (o: { reports?: GateReport[]; extra?: Partial<ApiClient> } = {}): Partial<ApiClient> =>
  ({
    getLatestGates: async () => ({ revision: 7, reports: o.reports ?? [] }),
    listRevisions: async () => ({ items: [{ version: 7, g0Passed: true }] }),
    getRevision: async () => ({ version: 7, spec: { compliance: {} } }),
    ...o.extra,
  }) as unknown as Partial<ApiClient>;

const card = (over: Partial<ComponentProps<typeof V3PublishCard>> = {}) =>
  h(V3PublishCard, {
    systemId: SYS,
    view: sysView(),
    run: null,
    onStarted: () => {},
    onChanged: () => {},
    ...over,
  });

describe("what stops the publication of a v3 system", () => {
  const base = { reports: [], target: 7, prodRevision: null, running: false };

  test("the operator's data is asked on its own; «Опубликовать» is off until the server says nothing stops it", () => {
    const m = v3PublishModel({ ...base, codes: ["OPERATOR_NAME_REQUIRED", "OPERATOR_ADDRESS_REQUIRED"] });
    expect(m).toMatchObject({ operator: true, address: true, inn: false, blockers: [], canPublish: false });
    expect(v3PublishModel({ ...base, codes: ["INN_INVALID"] }).inn).toBe(true);
    expect(v3PublishModel({ ...base, codes: [] }).canPublish).toBe(true);
  });

  test("a failed report of the build does not block a revision the server lets publish; GATES_FAILED names it", () => {
    const reports = [report("G0", true), report("G1", true), report("G2", false)];
    expect(v3PublishModel({ ...base, reports, codes: [] })).toMatchObject({ blockers: [], canPublish: true });
    const failed = v3PublishModel({ ...base, reports, codes: ["GATES_FAILED"] });
    const blocker = ru.publish.blockers.GATES_FAILED as (l: string) => string;
    expect(failed).toMatchObject({ gates: true, canPublish: false });
    expect(failed.blockers).toEqual([blocker(ru.build.gate.G2 ?? "G2")]);
  });

  test("not the owner, the card, the review, a run in flight and a revision already in prod", () => {
    expect(v3PublishModel({ ...base, codes: ["NOT_OWNER"] })).toMatchObject({
      owner: false,
      blockers: [],
      canPublish: false,
    });
    expect(v3PublishModel({ ...base, codes: ["CARD_BINDING_REQUIRED"] })).toMatchObject({
      billing: true,
      card: true,
      blockers: [ru.publish.blockers.CARD_BINDING_REQUIRED],
    });
    expect(v3PublishModel({ ...base, codes: ["FOUNDER_REVIEW_PENDING"] }).review).toBe(true);
    expect(v3PublishModel({ ...base, codes: [], running: true }).canPublish).toBe(false);
    expect(v3PublishModel({ ...base, codes: [], prodRevision: 7 })).toMatchObject({
      upToDate: true,
      canPublish: false,
    });
    expect(v3PublishModel({ ...base, codes: [], target: 8, prodRevision: 7 }).canPublish).toBe(true);
  });

  test("the publish run of the canvas events, the owner's cabinet address, the operator's data in words", () => {
    expect(publishRunState([ev(1, "run_started", { kind: "build" })])).toBeNull();
    expect(publishRunState([])).toBeNull();
    const done = publishRunState([
      ...PUBLISH_START,
      ev(2, "step_started", { step: "migrate", label_ru: "Переношу данные" }),
      ev(3, "run_finished", { summary_ru: "Ревизия 7 опубликована", prodUrl: PROD }),
    ]);
    expect(done?.phase).toBe("finished");
    expect(done?.finished?.prodUrl).toBe(PROD);
    expect(ownerCabinetUrl(PROD)).toBe("http://dental.localhost:4100/login?next=%2Fcabinet");
    expect(ownerCabinetUrl("не адрес")).toBeNull();
    const ok = { name: "ИП Иванова А. А.", contact: "privacy@dental.example", address: "Москва", inn: "" };
    expect(operatorProblem(ok, { address: true })).toBeNull();
    expect(operatorProblem({ ...ok, name: "ИП" }, { address: true })).toBe(publishRu.operator.nameShort);
    expect(operatorProblem({ ...ok, contact: "почта" }, { address: true })).toBe(
      publishRu.operator.contactBad,
    );
    expect(operatorProblem({ ...ok, address: " " }, { address: true })).toBe(
      publishRu.operator.addressNeeded,
    );
    expect(operatorProblem({ ...ok, address: "" }, { address: false })).toBeNull();
    expect(operatorProblem({ ...ok, inn: "12345" }, { address: true })).toBe(publishRu.operator.innBad);
  });
});

describe("the publication card of a built v3 system", () => {
  test("the operator's data in the chat: checked in words, saved with the draft revision, then re-read", async () => {
    const setCompliance = vi.fn(async () => ({ revision: { version: 8 } }));
    const onChanged = vi.fn();
    const codes = ["OPERATOR_NAME_REQUIRED", "OPERATOR_CONTACT_REQUIRED", "OPERATOR_ADDRESS_REQUIRED"];
    await mount(
      builtApi({ extra: { setCompliance } as unknown as Partial<ApiClient> }),
      card({ view: sysView({}, codes), onChanged }),
    );
    expect($("canvas-v3-publish-submit")?.hasAttribute("disabled")).toBe(true);
    expect($$("canvas-v3-publish-blocker")).toHaveLength(0);
    expect($("canvas-v3-operator")?.textContent).toContain("Данные оператора персональных данных");
    expect($("canvas-v3-operator-inn")).toBeNull();
    expect($("canvas-v3-operator-settings")?.getAttribute("href")).toBe(`/s/${SYS}/settings#pd`);

    await type("canvas-v3-operator-name", "ИП Иванова А. А.");
    await type("canvas-v3-operator-contact", "почта");
    await submit("canvas-v3-operator");
    expect($("canvas-v3-operator-error")?.textContent).toBe(publishRu.operator.contactBad);
    expect(setCompliance).not.toHaveBeenCalled();

    await type("canvas-v3-operator-contact", " privacy@dental.example ");
    await submit("canvas-v3-operator");
    expect($("canvas-v3-operator-error")?.textContent).toBe(publishRu.operator.addressNeeded);

    await type("canvas-v3-operator-address", "г. Москва, ул. Зубная, д. 1");
    await submit("canvas-v3-operator");
    expect(setCompliance).toHaveBeenCalledWith(SYS, {
      expectedVersion: 7,
      operatorName: "ИП Иванова А. А.",
      operatorContact: "privacy@dental.example",
      operatorAddress: "г. Москва, ул. Зубная, д. 1",
    });
    expect($("canvas-v3-operator-saved")?.textContent).toBe(publishRu.operator.saved);
    expect($("canvas-v3-operator-error")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("what the draft already has is prefilled; a stale version and a refusal are said in words", async () => {
    const setCompliance = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(412, { code: "VERSION_CONFLICT", message_ru: "Версия устарела" }))
      .mockRejectedValueOnce(new ApiError(422, { code: "VALIDATION_FAILED", message_ru: "Проверьте e-mail" }))
      .mockRejectedValueOnce(new ApiError(0, null));
    const getRevision = vi.fn(async () => ({
      version: 7,
      spec: { compliance: { operatorName: "ООО «Улыбка»", operatorContact: "pd@smile.example" } },
    }));
    const onChanged = vi.fn();
    await mount(
      builtApi({ extra: { setCompliance, getRevision } as unknown as Partial<ApiClient> }),
      card({ view: sysView({}, ["OPERATOR_ADDRESS_REQUIRED", "INN_INVALID"]), onChanged }),
    );
    expect(getRevision).toHaveBeenCalledWith(SYS, 7);
    expect(($("canvas-v3-operator-name") as HTMLInputElement).value).toBe("ООО «Улыбка»");
    expect(($("canvas-v3-operator-contact") as HTMLInputElement).value).toBe("pd@smile.example");
    expect($("canvas-v3-operator-inn")).not.toBeNull();
    await type("canvas-v3-operator-address", "г. Казань");
    await type("canvas-v3-operator-inn", "7707083893");
    await submit("canvas-v3-operator");
    expect($("canvas-v3-operator-error")?.textContent).toBe(publishRu.operator.stale);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await submit("canvas-v3-operator");
    expect($("canvas-v3-operator-error")?.textContent).toBe("Проверьте e-mail");
    await submit("canvas-v3-operator");
    expect($("canvas-v3-operator-error")?.textContent).toBe(ru.errors.network);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("nothing stops it: «Опубликовать» posts the latest revision and hands the run over; a refusal in words", async () => {
    const started = { id: RUN, kind: "publish", status: "queued", createdAt: "" };
    const publish = vi
      .fn()
      .mockResolvedValueOnce({ run: started })
      .mockRejectedValueOnce(
        new ApiError(403, { code: "FOUNDER_REVIEW_PENDING", message_ru: "Систему проверяет модератор" }),
      );
    const onStarted = vi.fn();
    const onChanged = vi.fn();
    const announce = vi.fn();
    await mount(
      builtApi({
        reports: [report("G0", true), report("G2", false)],
        extra: {
          publish,
          listRevisions: async () => ({ items: [{ version: 8, g0Passed: null }] }),
        } as unknown as Partial<ApiClient>,
      }),
      card({ onStarted, onChanged, announce }),
    );
    expect($("canvas-v3-operator")).toBeNull();
    expect($$("canvas-v3-publish-blocker")).toHaveLength(0);
    expect($("canvas-v3-publish")?.textContent).toContain(publishRu.lead);
    expect($("canvas-v3-publish-settings")?.getAttribute("href")).toBe(`/s/${SYS}/settings`);
    const submitBtn = $("canvas-v3-publish-submit");
    expect(submitBtn?.textContent).toBe("Опубликовать");
    expect(submitBtn?.hasAttribute("disabled")).toBe(false);
    await click("canvas-v3-publish-submit");
    expect(publish).toHaveBeenCalledWith(SYS, 8);
    expect(onStarted).toHaveBeenCalledWith(started);
    expect(announce).toHaveBeenCalledWith(publishRu.started);
    await click("canvas-v3-publish-submit");
    expect($("canvas-v3-publish-error")?.textContent).toBe("Систему проверяет модератор");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("the blockers in words with their places: checks, the card, the review", async () => {
    await mount(
      builtApi({ reports: [report("G0", true), report("G1", false)] }),
      card({ view: sysView({}, ["GATES_FAILED"]) }),
    );
    const blocker = ru.publish.blockers.GATES_FAILED as (l: string) => string;
    expect($$("canvas-v3-publish-blocker").map((x) => x.textContent)).toEqual([
      blocker(ru.build.gate.G1 ?? "G1"),
    ]);
    expect($("canvas-v3-publish")?.textContent).toContain(publishRu.gates);
    expect($("canvas-v3-publish")?.textContent).not.toMatch(/G[012]\b/);
    expect($("canvas-v3-publish-submit")?.hasAttribute("disabled")).toBe(true);
    act(() => root?.unmount());
    container?.remove();
    await mount(builtApi(), card({ view: sysView({}, ["CARD_BINDING_REQUIRED", "FOUNDER_REVIEW_PENDING"]) }));
    expect($("canvas-v3-publish-billing")?.textContent).toBe(ru.publish.bindCard);
    expect($("canvas-v3-publish-billing")?.getAttribute("href")).toBe("/billing");
    expect($("canvas-v3-publish-review")?.textContent).toBe(ru.publish.reviewHint);
  });

  test("not the owner: the reason in words, no button and no operator form", async () => {
    await mount(builtApi(), card({ view: sysView({}, ["NOT_OWNER", "OPERATOR_NAME_REQUIRED"]) }));
    expect($("canvas-v3-publish-owner-only")?.textContent).toBe(publishRu.ownerOnly);
    expect($("canvas-v3-publish-submit")).toBeNull();
    expect($("canvas-v3-operator")).toBeNull();
    expect($("canvas-v3-publish-settings")).not.toBeNull();
  });

  test("the publish run: its step, then the result; a failure in the server's words", async () => {
    const step = [...PUBLISH_START, ev(2, "step_started", { step: "migrate", label_ru: "Переношу данные" })];
    await mount(builtApi(), card({ run: run(step) }));
    expect($("canvas-v3-publish-progress")?.textContent).toBe(publishRu.runningStep("Переношу данные"));
    expect($("canvas-v3-publish-submit")?.hasAttribute("disabled")).toBe(true);
    act(() => root?.unmount());
    container?.remove();
    const failed = [
      ...PUBLISH_START,
      ev(2, "run_failed", { code: "GATES_FAILED", message_ru: "Систему посмотрит модератор" }),
    ];
    await mount(builtApi(), card({ run: run(failed) }));
    expect($("canvas-v3-publish-progress")).toBeNull();
    expect($("canvas-v3-publish-failed")?.textContent).toBe(
      `${publishRu.failed}: Систему посмотрит модератор`,
    );
  });

  test("a published system: the version, the site and the owner's cabinet; nothing new — no button", async () => {
    const finished = [...PUBLISH_START, ev(2, "run_finished", { summary_ru: "Ревизия 7 опубликована" })];
    await mount(builtApi(), card({ view: sysView({ prodRevision: 7, prodUrl: PROD }), run: run(finished) }));
    expect($("canvas-v3-publish-result")?.textContent).toBe(`${publishRu.done} · Ревизия 7 опубликована`);
    expect($("canvas-v3-publish-prod")?.textContent).toBe(ru.publish.published(7));
    expect($("canvas-v3-publish-site")?.getAttribute("href")).toBe(PROD);
    expect($("canvas-v3-publish-site")?.getAttribute("target")).toBe("_blank");
    expect($("canvas-v3-publish-cabinet")?.getAttribute("href")).toBe(`${PROD}login?next=%2Fcabinet`);
    expect($("canvas-v3-publish-uptodate")?.textContent).toBe(publishRu.upToDate);
    expect($("canvas-v3-publish-submit")).toBeNull();
    expect($("canvas-v3-publish-draft-cabinet")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    // A newer draft (the operator's data saved after the publication): «Опубликовать версию 8».
    await mount(
      builtApi({
        extra: { listRevisions: async () => ({ items: [{ version: 8 }] }) } as unknown as Partial<ApiClient>,
      }),
      card({ view: sysView({ draftRevision: 8, prodRevision: 7, prodUrl: PROD }) }),
    );
    expect($("canvas-v3-publish-submit")?.textContent).toBe(ru.publish.submitRevision(8));
  });

  test("the draft cabinet: a preview sign-in as the owner opens on the cabinet in a new tab", async () => {
    const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    const getPreviewUrl = vi
      .fn()
      .mockResolvedValueOnce({
        url: "http://dental--draft.localhost:4100/_wizard/dev-login?role=owner&next=/",
        revision: 7,
        roles: [],
        expiresAt: "",
      })
      .mockRejectedValueOnce(new ApiError(422, { code: "VALIDATION_FAILED", message_ru: "Такой роли нет" }));
    await mount(builtApi({ extra: { getPreviewUrl } as unknown as Partial<ApiClient> }), card());
    await click("canvas-v3-publish-draft-cabinet");
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(getPreviewUrl).toHaveBeenCalledWith(SYS, "owner");
    const u = new URL(tab.location.href);
    expect(u.searchParams.get("role")).toBe("owner");
    expect(u.searchParams.get("next")).toBe("/cabinet");
    expect(tab.opener).toBeNull();
    await click("canvas-v3-publish-draft-cabinet");
    expect(tab.close).toHaveBeenCalled();
    expect($("canvas-v3-publish-error")?.textContent).toBe(publishRu.noCabinet);
  });
});

/** An EventSource the test drives: the canvas subscribes to a run, the test pushes its frames. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((m: MessageEvent) => void)[]>();
  readyState = 1;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  push(e: RunEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) } as MessageEvent);
  }
}

describe("the canvas of a built v3 system", () => {
  test("the publication card and the settings link; the publish run is followed to «Опубликована»", async () => {
    FakeEventSource.all = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const brief = systemBriefSchema.parse(dentalBrief());
    const version = { version: 3, brief, diff: [], author: "agent", createdAt: "" };
    let view = sysView();
    const started = { id: RUN, kind: "publish", status: "queued", createdAt: "" };
    const publish = vi.fn(async () => ({ run: started }));
    const api = {
      ...builtApi({ extra: { publish } as unknown as Partial<ApiClient> }),
      getSystem: async () => view,
      getBrief: async () => ({ brief: version, diagrams: briefDiagrams(brief) }),
      getSystemPlan: async () => ({ plan: null }),
      listBriefVersions: async () => ({ versions: [], nextBefore: null }),
      listSessions: async () => ({ sessions: [] }),
      eventsUrl: (id: string, after: number) => `/api/v1/runs/${id}/events?after=${after}`,
      keys: { list: async () => ({ items: [], windows: [], needed: [] }) },
    } as unknown as Partial<ApiClient>;
    await mount(api, h(Canvas, { systemId: SYS, initial: view }));
    expect($("canvas-settings")?.getAttribute("href")).toBe(`/s/${SYS}/settings`);
    expect($("canvas-v3-publish")).not.toBeNull();
    expect($("canvas-ready")).toBeNull();

    await click("canvas-v3-publish-submit");
    expect(publish).toHaveBeenCalledWith(SYS, 7);
    const es = FakeEventSource.all.find((x) => x.url.includes(RUN)) as FakeEventSource;
    expect(es).toBeDefined();
    await act(async () => {
      es.push(PUBLISH_START[0] as RunEvent);
      es.push(ev(2, "step_started", { step: "migrate", label_ru: "Переношу данные" }));
    });
    await flush();
    expect($("canvas-v3-publish-progress")?.textContent).toBe(publishRu.runningStep("Переношу данные"));
    // The composer is not «thinking» while the system is published.
    expect($("canvas-composer")?.getAttribute("data-state")).not.toBe("thinking");

    view = sysView({ prodRevision: 7, prodUrl: PROD });
    await act(async () => {
      es.push(ev(3, "run_finished", { summary_ru: "Ревизия 7 опубликована", prodUrl: PROD }));
    });
    await flush();
    expect($("canvas-v3-publish-result")?.textContent).toContain(publishRu.done);
    expect($("canvas-v3-publish-prod")?.textContent).toBe(ru.publish.published(7));
    expect($("canvas-v3-publish-site")?.getAttribute("href")).toBe(PROD);
    expect($("canvas-v3-publish-cabinet")?.getAttribute("href")).toBe(`${PROD}login?next=%2Fcabinet`);
  });
});
