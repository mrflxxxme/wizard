// @vitest-environment happy-dom
// V3-31 «Репозиторий» in S10: hidden while the feature is off; the owner connects GitHub (leaves for the App install URL)
// or a self-managed GitLab (address, Application ID and Secret — the secret is cleared from the page after sending),
// picks the repository, sees the status with its Russian reason, the queue, the PRs with their gates and the refused
// imports with the reason; toggles auto-merge, pauses, retries and disconnects after a confirmation; a viewer only reads.
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiClient } from "../src/api/client.js";
import { PlatformProvider } from "../src/app/context.js";
import type { RepoSyncClient, RepoSyncLink, RepoSyncState } from "../src/screens/settings/repo/client.js";
import { RepoSync } from "../src/screens/settings/repo/RepoSync.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "22222222-2222-4222-8222-222222222222";
const SECRET = "gl-app-secret-canary-0123456789";

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const link = (over: Partial<RepoSyncLink> = {}): RepoSyncLink => ({
  id: "33333333-3333-4333-8333-333333333333",
  provider: "github",
  status: "active",
  statusRu: "Синхронизация работает",
  hostUrl: "https://github.com",
  repo: { id: "501", path: "acme/dental", webUrl: "https://github.com/acme/dental", defaultBranch: "main" },
  autoMerge: false,
  secretRef: "secret://repo/github",
  lastSyncAt: "2026-10-09T10:00:00Z",
  lastError: null,
  remoteHead: { oid: "a".repeat(40), revision: 4 },
  lastPushedRevision: 5,
  connectedAt: "2026-10-09T09:00:00Z",
  ...over,
});

const state = (over: Partial<RepoSyncState> = {}): RepoSyncState => ({
  available: true,
  providers: { github: true, gitlab: false, gitlabSelfManaged: true },
  link: null,
  prs: [],
  imports: [],
  queue: { waiting: 0, failing: 0, stopped: 0, nextAttemptAt: null },
  publishGate: { required: false, mergedRevision: null },
  ...over,
});

function fake(initial: RepoSyncState) {
  let st = initial;
  const calls: { op: string; args: unknown[] }[] = [];
  const client: RepoSyncClient = {
    get: async () => st,
    connectGithub: async (...args) => {
      calls.push({ op: "github", args });
      return { url: "https://github.com/apps/born-to-build/installations/new?state=s" };
    },
    connectGitlab: async (...args) => {
      calls.push({ op: "gitlab", args });
      return { url: "https://gitlab.company.ru/oauth/authorize?client_id=x" };
    },
    repos: async () => ({
      items: [
        {
          id: "501",
          path: "acme/dental",
          defaultBranch: "main",
          private: true,
          webUrl: "https://github.com/acme/dental",
        },
        {
          id: "502",
          path: "acme/site",
          defaultBranch: "main",
          private: false,
          webUrl: "https://github.com/acme/site",
        },
      ],
    }),
    selectRepo: async (...args) => {
      calls.push({ op: "select", args });
      st = state({ link: link() });
      return st;
    },
    update: async (_s, body) => {
      calls.push({ op: "update", args: [body] });
      st = {
        ...st,
        link: {
          ...(st.link as RepoSyncLink),
          ...(body.autoMerge !== undefined ? { autoMerge: body.autoMerge } : {}),
          ...(body.paused !== undefined ? { status: body.paused ? "paused" : "active" } : {}),
        },
      };
      return st;
    },
    retry: async (...args) => {
      calls.push({ op: "retry", args });
      return st;
    },
    disconnect: async (...args) => {
      calls.push({ op: "disconnect", args });
      st = state();
      return st;
    },
  };
  return { client, calls };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const q = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (el: HTMLElement | null) => {
  await act(async () => el?.click());
  await settle();
};
function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount(
  client: RepoSyncClient | undefined,
  owner = true,
  went: string[] = [],
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const api = {
    getMe: async () => ({}),
    getOrgSettings: async () => ({}),
    ...(client ? { repoSync: client } : {}),
  } as unknown as ApiClient;
  act(() =>
    root?.render(
      h(
        PlatformProvider,
        { api } as ComponentProps<typeof PlatformProvider>,
        h(RepoSync, {
          systemId: SYS,
          owner,
          go: (u: string) => went.push(u),
          origin: "https://borntobuild.ru",
        }),
      ),
    ),
  );
  await settle();
  return container;
}

describe("S10 «Репозиторий»", () => {
  test("off on the platform or an older API client → no section", async () => {
    const el = await mount(fake(state({ available: false })).client);
    expect(el.querySelector('[data-testid="settings-repo"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    const el2 = await mount(undefined);
    expect(el2.querySelector('[data-testid="settings-repo"]')).toBeNull();
  });

  test("connect GitHub leaves for the App's install page", async () => {
    const f = fake(state());
    const went: string[] = [];
    await mount(f.client, true, went);
    expect(q("settings-repo")?.textContent).toContain("Репозиторий");
    await click(q("repo-connect-github"));
    expect(went).toEqual(["https://github.com/apps/born-to-build/installations/new?state=s"]);
  });

  test("own GitLab: address, Application ID and Secret; the secret leaves the page after sending", async () => {
    const f = fake(state());
    const went: string[] = [];
    await mount(f.client, true, went);
    await click(q("repo-connect-gitlab"));
    expect(q<HTMLInputElement>("repo-gitlab-own")?.checked).toBe(true);
    expect(q<HTMLInputElement>("repo-gitlab-com")?.disabled).toBe(true);
    expect(q("repo-gitlab-form")?.textContent).toContain(
      "https://borntobuild.ru/api/v1/git-sync/gitlab/callback",
    );
    expect(q<HTMLButtonElement>("repo-gitlab-go")?.disabled).toBe(true);
    type(q("repo-gitlab-url"), "https://gitlab.company.ru");
    type(q("repo-gitlab-app-id"), "app-1");
    type(q("repo-gitlab-app-secret"), SECRET);
    await click(q("repo-gitlab-go"));
    expect(f.calls.find((c) => c.op === "gitlab")?.args[1]).toEqual({
      baseUrl: "https://gitlab.company.ru",
      clientId: "app-1",
      clientSecret: SECRET,
    });
    expect(went).toEqual(["https://gitlab.company.ru/oauth/authorize?client_id=x"]);
    expect(q<HTMLInputElement>("repo-gitlab-app-secret")?.value ?? "").toBe("");
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  test("pick the repository after the installation", async () => {
    const f = fake(
      state({ link: link({ status: "pending", statusRu: "Ждём выбора репозитория", repo: null }) }),
    );
    await mount(f.client);
    await settle();
    expect(q("repo-pick")?.textContent).toContain("acme/dental");
    expect(q("repo-pick-select")?.textContent).toContain("приватный");
    await click(q("repo-pick-submit"));
    expect(f.calls.find((c) => c.op === "select")?.args).toEqual([SYS, "501"]);
    expect(q("repo-linked")?.textContent).toContain("acme/dental");
    expect(q("repo-notice")?.textContent).toContain("первая отправка");
  });

  test("the state: error with its reason, the queue, PRs with gates, refused imports; owner actions", async () => {
    const f = fake(
      state({
        link: link({
          status: "error",
          statusRu: "Синхронизация остановлена из-за ошибки",
          lastError: { code: "UNAVAILABLE", message_ru: "GitHub сейчас недоступен. Повторим автоматически" },
        }),
        queue: { waiting: 2, failing: 1, stopped: 1, nextAttemptAt: "2026-10-09T10:05:00Z" },
        publishGate: { required: true, mergedRevision: 4 },
        prs: [
          {
            revision: 5,
            number: 7,
            url: "https://github.com/acme/dental/pull/7",
            branch: "wizard/dental/5",
            state: "open",
            checks: [
              { key: "G0", state: "success", title: "Пройдена" },
              { key: "G1", state: "failure", title: "Сценарий записи не прошёл" },
              { key: "G2", state: "neutral", title: "Не запускалась" },
              { key: "techreview", state: "pending", title: "Идёт" },
            ],
            createdAt: "2026-10-09T10:00:00Z",
          },
        ],
        imports: [
          {
            headOid: "b".repeat(40),
            status: "rejected",
            revision: null,
            baseRevision: 4,
            prNumber: null,
            reason_ru: "Конфликт: файл ui/About.tsx изменён и в репозитории, и в Wizard (ревизия 5)",
            warnings: [],
            createdAt: "2026-10-09T10:01:00Z",
          },
        ],
      }),
    );
    await mount(f.client);
    expect(q("repo-status")?.textContent).toBe("Синхронизация остановлена из-за ошибки");
    expect(q("repo-last-error")?.textContent).toContain("GitHub сейчас недоступен");
    expect(q("repo-queue")?.textContent).toContain("Ждут повтора: 1");
    expect(q("repo-stopped")?.textContent).toContain("Остановлено после повторов: 1");
    expect(q("repo-publish-gate")?.textContent).toBe(
      "Публикация — после мержа: в основной ветке сейчас ревизия 4.",
    );
    expect(q("repo-pr")?.textContent).toContain("#7");
    expect(q("repo-check-G1")?.textContent).toBe("G1: не пройдена");
    expect(q("repo-check-G1")?.getAttribute("title")).toBe("Сценарий записи не прошёл");
    expect(q("repo-import-reason")?.textContent).toMatch(/^Конфликт: файл ui\/About\.tsx/);
    expect(document.body.innerHTML).not.toContain("secret://repo/github?");

    await click(q("repo-auto-merge"));
    expect(f.calls.at(-1)).toEqual({ op: "update", args: [{ autoMerge: true }] });
    expect(q<HTMLInputElement>("repo-auto-merge")?.checked).toBe(true);
    await click(q("repo-retry"));
    expect(f.calls.at(-1)?.op).toBe("retry");
    await click(q("repo-pause"));
    expect(f.calls.at(-1)).toEqual({ op: "update", args: [{ paused: true }] });
    expect(q("repo-pause")?.textContent).toBe("Возобновить");

    await click(q("repo-disconnect"));
    expect(q("repo-disconnect-confirm")?.textContent).toContain("Отключить acme/dental?");
    await click(q("repo-disconnect-no"));
    expect(q("repo-disconnect-confirm")).toBeNull();
    await click(q("repo-disconnect"));
    await click(q("repo-disconnect-yes"));
    expect(f.calls.at(-1)?.op).toBe("disconnect");
    expect(q("repo-connect-github")).not.toBeNull();
  });

  test("a viewer reads the state but has no actions", async () => {
    await mount(fake(state({ link: link() })).client, false);
    expect(q("repo-linked")?.textContent).toContain("acme/dental");
    expect(q("repo-auto-merge")).toBeNull();
    expect(q("repo-disconnect")).toBeNull();
    expect(qa("repo-connect-github")).toEqual([]);
    expect(q("settings-repo")?.textContent).toContain("может владелец организации");
  });
});
