// Typed client of the M0 subset of specs/platform/api.yaml. Mutations carry Idempotency-Key (one uuid per click).
import { ru } from "../i18n/ru.js";
import type {
  AbuseCategory,
  AbuseReport,
  AbuseStatus,
  AbuseTicket,
  Answer,
  ApiErrorBody,
  Billing,
  CreditBalance,
  DeletionLogEntry,
  DiffChange,
  ExportView,
  FounderReviewItem,
  GateReport,
  ImportColumnMapping,
  ImportView,
  Invite,
  LedgerEntry,
  LlmSpend,
  LockStatus,
  Me,
  Member,
  Message,
  MessageTarget,
  Org,
  OrgSettings,
  PilotInvite,
  PilotOrg,
  PilotReadiness,
  PreviewUrl,
  Publication,
  Revision,
  RevisionSummary,
  Run,
  StaffData,
  StaffSession,
  System,
  SystemDeleted,
  SystemView,
  Theme,
  User,
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
  /** 401 UNAUTHORIZED of any call (session expired or absent, api.yaml x-auth M1) → the app shows /login. */
  onUnauthorized?: () => void;
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
      /** Plain-text response (GET /systems/:id/files/*path). */
      text?: boolean;
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
    if (res.ok && init.text) {
      // Binary sources come as application/octet-stream attachments: never shown, never downloaded (D14).
      if (!(res.headers.get("content-type") ?? "").startsWith("text/"))
        throw new ApiError(415, { code: "BINARY", message_ru: ru.code.binary });
      return text as T;
    }
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new ApiError(res.status, (data as ApiErrorBody | null) ?? null);
      if (res.status === 401 && err.code === "UNAUTHORIZED") opts.onUnauthorized?.();
      throw err;
    }
    return data as T;
  }

  const sys = (id: string) => `/systems/${encodeURIComponent(id)}`;
  const run = (id: string) => `/runs/${encodeURIComponent(id)}`;
  const org = (id: string) => `/orgs/${encodeURIComponent(id)}`;

  return {
    listSystems: (orgId?: string) =>
      call<{ items: System[]; nextCursor?: string | null }>("GET", "/systems", { query: { orgId } }),
    createSystem: (
      body: { prompt: string; templateId?: string; orgId?: string },
      idempotencyKey = newIdempotencyKey(),
    ) => call<{ system: System; run: Run }>("POST", "/systems", { body, idempotencyKey }),
    getSystem: (id: string) => call<SystemView>("GET", sys(id)),
    /** With target (M3-01) the request becomes a point_edit build of target.file. */
    postMessage: (
      id: string,
      text: string,
      opts: { target?: MessageTarget } = {},
      idempotencyKey = newIdempotencyKey(),
    ) =>
      call<{ message: Message; run: Run }>("POST", `${sys(id)}/messages`, {
        body: opts.target ? { text, target: opts.target } : { text },
        idempotencyKey,
      }),
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
    listRevisions: (id: string, limit?: number) =>
      call<{ items: RevisionSummary[] }>("GET", `${sys(id)}/revisions`, {
        query: { limit: limit === undefined ? undefined : String(limit) },
      }),
    getRevisionDiff: (id: string, v: number, from?: number | null) =>
      call<{ changes: DiffChange[] }>("GET", `${sys(id)}/revisions/${v}/diff`, {
        query: { from: from == null ? undefined : String(from) },
      }),
    /** Source of a revision file as text (api.yaml#getFile, text/plain); binary files answer with bytes. */
    getFileText: (id: string, path: string, rev: number) =>
      call<string>("GET", `${sys(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, {
        query: { rev: String(rev) },
        text: true,
      }),
    listPublications: (id: string) => call<{ items: Publication[] }>("GET", `${sys(id)}/publications`),
    publish: (id: string, revision: number, idempotencyKey = newIdempotencyKey()) =>
      call<{ run: Run }>("POST", `${sys(id)}/publish`, {
        body: { revision, confirmDiff: true },
        idempotencyKey,
      }),
    rollback: (
      id: string,
      body: { env: "draft" | "prod"; toRevision: number },
      idempotencyKey = newIdempotencyKey(),
    ) => call<{ run: Run }>("POST", `${sys(id)}/rollback`, { body, idempotencyKey }),
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
    getOrgSettings: (orgId: string) => call<OrgSettings>("GET", `${org(orgId)}/settings`),
    updateOrgSettings: (orgId: string, body: { ruOnly: boolean }) =>
      call<OrgSettings>("PATCH", `${org(orgId)}/settings`, { body }),
    // Accounts (api.yaml x-milestone M1, M1-02).
    requestOtp: (email: string) => call<null>("POST", "/auth/otp/request", { body: { email } }),
    verifyOtp: (body: { email: string; code: string; acceptOffer?: boolean; pdConsent?: boolean }) =>
      call<{ user: User }>("POST", "/auth/otp/verify", { body }),
    logout: () => call<null>("POST", "/auth/logout"),
    getMe: () => call<Me>("GET", "/me"),
    acceptInvite: (token: string) =>
      call<Member>("POST", `/invites/${encodeURIComponent(token)}/accept`, {
        idempotencyKey: newIdempotencyKey(),
      }),
    listMembers: (orgId: string) => call<{ items: Member[] }>("GET", `${org(orgId)}/members`),
    updateMemberRole: (orgId: string, userId: string, role: Member["role"]) =>
      call<Member>("PATCH", `${org(orgId)}/members/${encodeURIComponent(userId)}`, { body: { role } }),
    removeMember: (orgId: string, userId: string) =>
      call<null>("DELETE", `${org(orgId)}/members/${encodeURIComponent(userId)}`),
    listInvites: (orgId: string) => call<{ items: Invite[] }>("GET", `${org(orgId)}/invites`),
    createInvite: (orgId: string, body: { email: string; role: Member["role"] }) =>
      call<Invite>("POST", `${org(orgId)}/invites`, { body, idempotencyKey: newIdempotencyKey() }),
    revokeInvite: (orgId: string, inviteId: string) =>
      call<null>("DELETE", `${org(orgId)}/invites/${encodeURIComponent(inviteId)}`),
    getLock: (id: string) => call<LockStatus>("GET", `${sys(id)}/lock`),
    releaseLock: (id: string) => call<null>("DELETE", `${sys(id)}/lock`),
    setCompliance: (
      id: string,
      body: {
        expectedVersion: number;
        operatorName: string;
        operatorContact: string;
        operatorAddress?: string;
        operatorInn?: string;
        /** Lawyer's template (agents/consent.ts ids); consentText — the owner's own text instead (M2-11). */
        consentTemplateId?: string;
        consentText?: string;
      },
    ) => call<{ revision: RevisionSummary }>("PUT", `${sys(id)}/compliance`, { body }),
    // 152-ФЗ of the owner (M2-05): deletion journal and the soft delete of a system.
    listDeletionLog: (id: string, cursor?: string, limit = 20) =>
      call<{ items: DeletionLogEntry[]; nextCursor: string | null }>("GET", `${sys(id)}/deletion-log`, {
        query: { limit: String(limit), cursor },
      }),
    deleteSystem: (id: string) => call<SystemDeleted>("DELETE", sys(id)),
    // Data export (M2-10): run → ZIP; getExport issues a fresh single-use downloadUrl on every call when ready.
    createExport: (id: string, body: { env: "draft" | "prod"; includePii?: boolean }) =>
      call<{ exportId: string; run: Run }>("POST", `${sys(id)}/exports`, {
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    listExports: (id: string) => call<{ items: ExportView[] }>("GET", `${sys(id)}/exports`),
    getExport: (id: string, exportId: string) =>
      call<ExportView>("GET", `${sys(id)}/exports/${encodeURIComponent(exportId)}`),
    // Plan, balance and the platform shop (M1-03, M2-07; S-billing).
    getOrg: (orgId: string) => call<Org>("GET", org(orgId)),
    getCredits: (orgId: string) => call<CreditBalance>("GET", `${org(orgId)}/credits`),
    listLedger: (orgId: string, cursor?: string, limit = 20) =>
      call<{ items: LedgerEntry[]; nextCursor: string | null }>("GET", `${org(orgId)}/credits/ledger`, {
        query: { limit: String(limit), cursor },
      }),
    getBilling: (orgId: string) => call<Billing>("GET", `${org(orgId)}/billing`),
    startCardBinding: (orgId: string) =>
      call<{ confirmationUrl: string }>("POST", `${org(orgId)}/billing/card-binding`, {
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    changeSubscription: (orgId: string, plan: "start" | "business") =>
      call<Billing>("PUT", `${org(orgId)}/billing/subscription`, { body: { plan } }),
    cancelSubscription: (orgId: string) => call<Billing>("DELETE", `${org(orgId)}/billing/subscription`),
    createTopup: (orgId: string, packs: number) =>
      call<{ confirmationUrl: string | null; paymentId: string }>("POST", `${org(orgId)}/billing/topups`, {
        body: { packs },
        idempotencyKey: newIdempotencyKey(),
      }),
    // Table import (api.yaml#createImport, #getImport, #updateImportMapping; M1-07).
    createImport: (id: string, file: Blob, name: string) => {
      const form = new FormData();
      form.set("file", file, name);
      return call<{ importId: string; run: Run }>("POST", `${sys(id)}/imports`, {
        body: form,
        idempotencyKey: newIdempotencyKey(),
      });
    },
    getImport: (id: string, importId: string) =>
      call<ImportView>("GET", `${sys(id)}/imports/${encodeURIComponent(importId)}`),
    updateImportMapping: (id: string, importId: string, mapping: ImportColumnMapping[]) =>
      call<{ mapping: ImportColumnMapping[] }>(
        "PUT",
        `${sys(id)}/imports/${encodeURIComponent(importId)}/mapping`,
        {
          body: { mapping },
        },
      ),
    // «Пожаловаться» (M2-08, no login) and the staff console /admin (api.yaml x-auth M2).
    createAbuseReport: (body: {
      url: string;
      category: AbuseCategory;
      text?: string;
      contactEmail?: string;
      contactConsent?: boolean;
    }) => call<{ reportId: string }>("POST", "/abuse-reports", { body }),
    adminSession: () => call<StaffSession>("GET", "/admin/session"),
    adminMfaEnroll: () => call<{ secret: string; otpauthUrl: string }>("POST", "/admin/mfa/enroll"),
    adminMfaConfirm: (code: string) =>
      call<{ recoveryCodes: string[]; mfaVerifiedUntil: string }>("POST", "/admin/mfa/confirm", {
        body: { code },
      }),
    adminMfaVerify: (body: { code: string } | { recoveryCode: string }) =>
      call<{ mfaVerifiedUntil: string }>("POST", "/admin/mfa/verify", { body }),
    adminListAbuseReports: (status?: AbuseStatus) =>
      call<{ items: AbuseReport[] }>("GET", "/admin/abuse-reports", { query: { status } }),
    adminGetAbuseReport: (id: string) =>
      call<AbuseTicket>("GET", `/admin/abuse-reports/${encodeURIComponent(id)}`),
    adminAbuseAction: (
      id: string,
      body: { action: "triage" | "takedown" | "dismiss" | "restore"; note: string; category?: AbuseCategory },
    ) => call<AbuseReport>("POST", `/admin/abuse-reports/${encodeURIComponent(id)}/actions`, { body }),
    adminOpenStaffAccess: (id: string, note: string) =>
      call<{ until: string }>("POST", `/admin/abuse-reports/${encodeURIComponent(id)}/access`, {
        body: { note },
      }),
    adminSystemData: (id: string, entity?: string) =>
      call<StaffData>("GET", `/admin/abuse-reports/${encodeURIComponent(id)}/data`, { query: { entity } }),
    adminListFounderReviews: () => call<{ items: FounderReviewItem[] }>("GET", "/admin/founder-reviews"),
    adminFounderReview: (
      systemId: string,
      body: { revision: number; decision: "approve" | "reject"; note?: string },
    ) =>
      call<{ systemId: string; revision: number; status: string }>(
        "POST",
        `/admin/systems/${encodeURIComponent(systemId)}/founder-review`,
        { body },
      ),
    // abuse.yaml#takedown.flow: org-wide suspension (staff) and «Оспорить» a G2 antifraud stop (owner).
    adminOrgSuspension: (
      orgId: string,
      body: { action: "suspend" | "restore"; note: string; reportId?: string },
    ) =>
      call<{ orgId: string; suspendedAt: string | null }>(
        "POST",
        `/admin/orgs/${encodeURIComponent(orgId)}/suspension`,
        { body },
      ),
    // Staff console «Пилот» (/admin/pilot/*): the same operations as the founder CLI `pilot`.
    adminPilotReadiness: () => call<PilotReadiness>("GET", "/admin/pilot/readiness"),
    adminSetPilotReadiness: (body: { on: boolean; confirm?: boolean; note?: string }) =>
      call<PilotReadiness>("PUT", "/admin/pilot/readiness", { body }),
    adminListPilotInvites: () => call<{ items: PilotInvite[] }>("GET", "/admin/pilot/invites"),
    adminCreatePilotInvite: (body: {
      email: string;
      orgName?: string;
      credits?: number;
      requireFounderReview?: boolean;
    }) =>
      call<{ id: string; email: string; expiresAt: string; link: string; requireFounderReview: boolean }>(
        "POST",
        "/admin/pilot/invites",
        { body },
      ),
    adminRevokePilotInvite: (id: string) =>
      call<{ id: string; status: "revoked" }>(
        "POST",
        `/admin/pilot/invites/${encodeURIComponent(id)}/revoke`,
      ),
    adminListPilotOrgs: () =>
      call<{ month: string; capRub: number; items: PilotOrg[] }>("GET", "/admin/pilot/orgs"),
    adminGrantPilotCredits: (orgId: string, body: { credits: number; reference: string }) =>
      call<{ orgId: string; granted: boolean; reference: string; creditsAvailable: number }>(
        "POST",
        `/admin/pilot/orgs/${encodeURIComponent(orgId)}/grants`,
        { body },
      ),
    adminSetPilotFounderReview: (orgId: string, on: boolean) =>
      call<{ orgId: string; requireFounderReview: boolean }>(
        "PUT",
        `/admin/pilot/orgs/${encodeURIComponent(orgId)}/founder-review`,
        { body: { on } },
      ),
    adminPilotSpend: () => call<LlmSpend>("GET", "/admin/pilot/spend"),
    disputeG2Block: (id: string, body: { revision: number; text?: string }) =>
      call<{ reportId: string; message_ru: string }>("POST", `${sys(id)}/disputes`, { body }),
    eventsUrl: (runId: string, after = 0) => `${base}${run(runId)}/events?after=${after}`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
