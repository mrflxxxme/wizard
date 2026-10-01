// Typed client of the M0 subset of specs/platform/api.yaml. Mutations carry Idempotency-Key (one uuid per click).
import { ru } from "../i18n/ru.js";
import type {
  Answer,
  ApiErrorBody,
  GateReport,
  Message,
  OrgSettings,
  PreviewUrl,
  Revision,
  RevisionSummary,
  Run,
  System,
  SystemView,
  Theme,
} from "./types.js";

export const API_BASE = "/api/v1";
/** api.yaml#info.x-auth.M0: the single seeded organization. */
export const M0_ORG_ID = "00000000-0000-0000-0000-000000000001";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, body: Partial<ApiErrorBody> | null) {
    super(body?.message_ru || ru.errors.generic);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code ?? (status === 0 ? "NETWORK" : "INTERNAL");
    this.details = body?.details;
  }
}

export interface ClientOptions {
  base?: string;
  /** M0: X-Wizard-Dev-User; omitted → dev@wizard.local on the server. */
  devUser?: string;
  fetch?: typeof fetch;
}

export const newIdempotencyKey = (): string => crypto.randomUUID();

/** api.yaml#info.x-auth.M1: double-submit CSRF — the readable wizard_csrf cookie goes back as X-Wizard-CSRF. */
export function csrfToken(cookie: string = globalThis.document?.cookie ?? ""): string | undefined {
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "__Host-wizard_csrf" || k === "wizard_csrf") return v.join("=") || undefined;
  }
  return undefined;
}

type Json = Record<string, unknown>;

export function createApiClient(opts: ClientOptions = {}) {
  const base = opts.base ?? API_BASE;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(
    method: string,
    path: string,
    init: {
      body?: Json | FormData;
      idempotencyKey?: string;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.devUser) headers["X-Wizard-Dev-User"] = opts.devUser;
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
    const csrf = method === "GET" ? undefined : csrfToken();
    if (csrf) headers["X-Wizard-CSRF"] = csrf;
    let body: BodyInit | undefined;
    if (init.body instanceof FormData) body = init.body;
    else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) q.set(k, v);
    const qs = q.size > 0 ? `?${q}` : "";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs}`, { method, headers, body, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, { code: "NETWORK", message_ru: ru.errors.network });
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(res.status, (data as ApiErrorBody | null) ?? null);
    return data as T;
  }

  const sys = (id: string) => `/systems/${encodeURIComponent(id)}`;
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;

  return {
    listSystems: () => call<{ items: System[]; nextCursor?: string | null }>("GET", "/systems"),
    createSystem: (body: { prompt: string; templateId?: string }, idempotencyKey = newIdempotencyKey()) =>
      call<{ system: System; run: Run }>("POST", "/systems", { body, idempotencyKey }),
    getSystem: (id: string) => call<SystemView>("GET", sys(id)),
    postMessage: (id: string, text: string, idempotencyKey = newIdempotencyKey()) =>
      call<{ message: Message; run: Run }>("POST", `${sys(id)}/messages`, { body: { text }, idempotencyKey }),
    postAnswers: (
      id: string,
      body: { answers: Answer[]; restByRecommendation?: boolean },
      idempotencyKey = newIdempotencyKey(),
    ) => call<{ run: Run }>("POST", `${sys(id)}/answers`, { body, idempotencyKey }),
    approveCard: (
      id: string,
      body: { cardVersion: number; capCredits?: number },
      idempotencyKey = newIdempotencyKey(),
    ) => call<{ run: Run }>("POST", `${sys(id)}/card/approve`, { body, idempotencyKey }),
    startFix: (id: string, idempotencyKey = newIdempotencyKey()) =>
      call<{ run: Run }>("POST", `${sys(id)}/fix`, { body: {}, idempotencyKey }),
    getRevision: (id: string, v: number) => call<Revision>("GET", `${sys(id)}/revisions/${v}`),
    setStyle: (id: string, body: { expectedVersion: number; theme: Theme }) =>
      call<{ revision: RevisionSummary }>("POST", `${sys(id)}/style`, { body }),
    uploadLogo: (id: string, file: Blob, expectedVersion: number) => {
      const form = new FormData();
      form.set("file", file);
      form.set("purpose", "logo");
      form.set("expectedVersion", String(expectedVersion));
      return call<{ path: string; sha256: string; revision: RevisionSummary }>("POST", `${sys(id)}/assets`, {
        body: form,
      });
    },
    getPreviewUrl: (id: string, role?: string) =>
      call<PreviewUrl>("GET", `${sys(id)}/preview-url`, { query: { role } }),
    getLatestGates: (id: string) =>
      call<{ revision: number; runId?: string; reports: GateReport[] }>("GET", `${sys(id)}/gates/latest`),
    getRun: (id: string) => call<Run>("GET", run(id)),
    cancelRun: (id: string) =>
      call<Run>("POST", `${run(id)}/cancel`, { idempotencyKey: newIdempotencyKey() }),
    provideInput: (
      id: string,
      body: { inputId: string; choice?: string; text?: string; secretValue?: string },
    ) => call<Run>("POST", `${run(id)}/input`, { body, idempotencyKey: newIdempotencyKey() }),
    getOrgSettings: (orgId: string) =>
      call<OrgSettings>("GET", `/orgs/${encodeURIComponent(orgId)}/settings`),
    eventsUrl: (runId: string, after = 0) => `${base}${run(runId)}/events?after=${after}`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
