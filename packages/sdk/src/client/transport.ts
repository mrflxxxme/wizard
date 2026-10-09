// Small fetch client for the runtime API (runtime.yaml#data_api, #functions, #auth, #realtime) with one
// shared SSE connection per client (sdk.md §3). No React here: hooks live in ./react.tsx.
import { ERROR_MESSAGES, WizardError } from "../errors.js";
import type { CallOptions, ClientUser, ErrorDetails } from "../sdk.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface InvalidateMessage {
  type: "invalidate";
  entity: string;
  id?: string;
  op?: "insert" | "update" | "delete";
}
/** Emitted after the SSE stream reconnects or the user changes: every active query refetches. */
export interface ResyncMessage {
  type: "resync";
}
export type RealtimeMessage = InvalidateMessage | ResyncMessage;

/**
 * `_consent` body field, canonical format of security/compliance.yaml#consent: both values come from
 * RoleSpec.compliance (GET /_wizard/spec); time and ip_hmac are set by the server.
 */
export interface ConsentPayload {
  policyVersion: string;
  textHash: string;
}

export interface SdkClientOptions {
  /** Origin + prefix of the runtime; default "" (same origin). */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Open GET /api/events while something is subscribed (default true). */
  realtime?: boolean;
  /** Consent metadata; default: derived from GET /_wizard/spec (RoleSpec.compliance). */
  consent?: ConsentPayload | (() => Promise<ConsentPayload>);
  /** First reconnect delay; doubles up to 10 s. */
  reconnectDelayMs?: number;
}

export interface ListParams {
  filter?: Record<string, unknown>;
  sort?: string | readonly string[];
  page?: number;
  limit?: number;
  /** `q`: search over the role's readable text, phone and int fields (runtime.yaml#data_api.query_params.q). */
  search?: string;
}
export interface ListResponse<T = Record<string, unknown>> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  totalCapped?: boolean;
}

export interface UserSnapshot {
  user: ClientUser | null;
  isLoading: boolean;
}

const FILTER_OPS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"]);

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return String(v);
}

/** filter[<field>]=<v> | filter[<field>][<op>]=<v>; `in` is comma-joined (runtime.yaml#data_api.query_params). */
export function buildListQuery(p: ListParams): string {
  const q = new URLSearchParams();
  for (const [field, cond] of Object.entries(p.filter ?? {})) {
    if (cond === undefined) continue;
    const isOps =
      typeof cond === "object" &&
      cond !== null &&
      !Array.isArray(cond) &&
      Object.keys(cond).length > 0 &&
      Object.keys(cond).every((k) => FILTER_OPS.has(k));
    if (!isOps) {
      q.append(`filter[${field}]`, scalar(cond));
      continue;
    }
    for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
      if (v === undefined) continue;
      q.append(
        `filter[${field}][${op}]`,
        op === "in" && Array.isArray(v) ? v.map(scalar).join(",") : scalar(v),
      );
    }
  }
  if (p.sort !== undefined) {
    const s = typeof p.sort === "string" ? p.sort : p.sort.join(",");
    if (s) q.set("sort", s);
  }
  if (p.page !== undefined) q.set("page", String(p.page));
  if (p.limit !== undefined) q.set("limit", String(p.limit));
  if (p.search?.trim()) q.set("q", p.search.trim());
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Incremental text/event-stream parser. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  constructor(private readonly onEvent: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith("\r\n", nl) ? 2 : 1));
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) this.onEvent(this.event || "message", this.data.join("\n"));
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const name = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") this.event = value;
    else if (name === "data") this.data.push(value);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toClientUser(raw: unknown): ClientUser | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.id !== "string" || typeof u.role !== "string") return null;
  return {
    id: u.id as ClientUser["id"],
    role: u.role as ClientUser["role"],
    displayName: String(u.displayName ?? u.display_name ?? ""),
    isAdmin: u.isAdmin === true,
  };
}

export class SdkClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly realtime: boolean;
  private readonly reconnectDelayMs: number;
  private readonly consentOpt: SdkClientOptions["consent"];
  private consentCache: Promise<ConsentPayload> | undefined;

  private readonly listeners = new Set<(m: RealtimeMessage) => void>();
  private sse: AbortController | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private connectedOnce = false;

  private userSnap: UserSnapshot = { user: null, isLoading: true };
  private userLoad: Promise<ClientUser | null> | undefined;
  private readonly userListeners = new Set<() => void>();

  constructor(o: SdkClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? "").replace(/\/$/, "");
    const f = o.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("@wizard/sdk: fetch is not available");
    this.fetchImpl = o.fetch ? f : (input, init) => f.call(globalThis, input, init);
    this.realtime = o.realtime ?? true;
    this.reconnectDelayMs = o.reconnectDelayMs ?? 500;
    this.consentOpt = o.consent;
  }

  // ---------- HTTP ----------

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Every SDK request carries X-Wizard-Request (sdk.md §3, runtime.yaml#auth.csrf).
    const headers: Record<string, string> = { Accept: "application/json", "X-Wizard-Request": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      const e = new WizardError("NETWORK", { message: ERROR_MESSAGES.NETWORK });
      e.status = 0;
      throw e;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) throw SdkClient.toError(res.status, json);
    return json as T;
  }

  static toError(status: number, json: unknown): WizardError {
    const err = (json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)
      ?.error;
    const code = typeof err?.code === "string" ? err.code : status >= 500 ? "INTERNAL" : "HTTP_ERROR";
    const details: ErrorDetails = {
      ...(err?.details && typeof err.details === "object" ? (err.details as ErrorDetails) : {}),
    };
    details.message =
      typeof err?.message === "string" ? err.message : (ERROR_MESSAGES[code] ?? "Ошибка запроса");
    const e = new WizardError(code, details);
    e.status = status;
    return e;
  }

  // ---------- consent ----------

  private consentInfo(): Promise<ConsentPayload> {
    if (this.consentOpt) {
      return typeof this.consentOpt === "function" ? this.consentOpt() : Promise.resolve(this.consentOpt);
    }
    this.consentCache ??= this.request<{
      compliance?: { policyVersion?: unknown; consentTextHash?: unknown; consentText?: unknown };
    }>("GET", "/_wizard/spec").then(async (spec) => {
      const c = spec?.compliance;
      const textHash =
        typeof c?.consentTextHash === "string"
          ? c.consentTextHash
          : typeof c?.consentText === "string"
            ? await sha256Hex(c.consentText)
            : undefined;
      if (typeof c?.policyVersion !== "string" || textHash === undefined) {
        throw new WizardError("CONSENT_REQUIRED", { message: ERROR_MESSAGES.CONSENT_REQUIRED });
      }
      return { policyVersion: c.policyVersion, textHash };
    });
    this.consentCache.catch(() => {
      this.consentCache = undefined;
    });
    return this.consentCache;
  }

  private async withConsent(
    body: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<Record<string, unknown>> {
    if (opts?.consent !== true) return body;
    const _consent: ConsentPayload = { ...(await this.consentInfo()) };
    return { ...body, _consent };
  }

  // ---------- functions & data ----------

  async callFunction(
    name: string,
    args: unknown,
    opts?: CallOptions,
  ): Promise<{ result: unknown; deps: string[] }> {
    const body = await this.withConsent({ args: args ?? {} }, opts);
    const r = await this.request<{ result?: unknown; deps?: unknown }>(
      "POST",
      `/api/fn/${encodeURIComponent(name)}`,
      body,
    );
    return { result: r?.result ?? null, deps: Array.isArray(r?.deps) ? r.deps.map(String) : [] };
  }

  listEntities<T = Record<string, unknown>>(entity: string, p: ListParams = {}): Promise<ListResponse<T>> {
    return this.request("GET", `/api/data/${encodeURIComponent(entity)}${buildListQuery(p)}`);
  }

  /** 404 → null (row absent or outside the role's rowFilter). */
  async getEntity<T = Record<string, unknown>>(entity: string, id: string): Promise<T | null> {
    try {
      const r = await this.request<{ item: T }>(
        "GET",
        `/api/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
      );
      return r.item;
    } catch (e) {
      if (e instanceof WizardError && e.status === 404) return null;
      throw e;
    }
  }

  async createEntity<T = Record<string, unknown>>(
    entity: string,
    doc: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const body = await this.withConsent({ ...(doc as Record<string, unknown>) }, opts);
    const r = await this.request<{ item: T }>("POST", `/api/data/${encodeURIComponent(entity)}`, body);
    return r.item;
  }

  async updateEntity<T = Record<string, unknown>>(
    entity: string,
    id: string,
    patch: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const body = await this.withConsent({ ...(patch as Record<string, unknown>) }, opts);
    const r = await this.request<{ item: T }>(
      "PATCH",
      `/api/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
      body,
    );
    return r.item;
  }

  async removeEntity(entity: string, id: string): Promise<void> {
    await this.request("DELETE", `/api/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`);
  }

  /**
   * POST /api/ai/:action {entity, id} (runtime.yaml#ai_actions, M3-02): the runtime fills the target fields with the
   * action's result; the answer is the record with `_aiFilled` plus the filled and skipped fields.
   */
  async runAiAction<T = Record<string, unknown>>(
    action: string,
    entity: string,
    id: string,
  ): Promise<{ item: T & { _aiFilled: string[] }; filled: string[]; skipped: string[] }> {
    return this.request("POST", `/api/ai/${encodeURIComponent(action)}`, { entity, id });
  }

  /**
   * POST /api/pay/:integration → confirmationUrl (connectors/yookassa.yaml#runtime_endpoint); `token` (V3-23) — the
   * buyer's secret of an order the caller cannot read (the binding's accessField).
   */
  async pay(integration: string, binding: string, id: string, token?: string): Promise<string> {
    const r = await this.request<{ confirmationUrl: string }>(
      "POST",
      `/api/pay/${encodeURIComponent(integration)}`,
      {
        binding,
        id,
        ...(token ? { token } : {}),
      },
    );
    return r.confirmationUrl;
  }

  /**
   * POST /api/pay/:integration/check (V3-23, yookassa.yaml#return_check): back from the payment page, asks the runtime to
   * re-read the record's pending payment from ЮKassa; resolves to the outcome («applied», «pending», «throttled»…).
   */
  async payCheck(integration: string, binding: string, id: string, token?: string): Promise<string> {
    const r = await this.request<{ result: string }>(
      "POST",
      `/api/pay/${encodeURIComponent(integration)}/check`,
      { binding, id, ...(token ? { token } : {}) },
    );
    return r.result;
  }

  // ---------- auth ----------

  getUserSnapshot = (): UserSnapshot => this.userSnap;

  subscribeUser = (cb: () => void): (() => void) => {
    this.userListeners.add(cb);
    return () => {
      this.userListeners.delete(cb);
    };
  };

  private setUser(snap: UserSnapshot): void {
    this.userSnap = snap;
    for (const l of this.userListeners) l();
  }

  /** GET /api/auth/me once (deduplicated); 401 → null. */
  loadUser(force = false): Promise<ClientUser | null> {
    if (this.userLoad && !force) return this.userLoad;
    const p = this.request<{ user?: unknown }>("GET", "/api/auth/me").then(
      (r) => toClientUser(r?.user),
      (e: unknown) => {
        if (e instanceof WizardError && e.status === 401) return null;
        throw e;
      },
    );
    this.userLoad = p;
    p.then(
      (user) => {
        if (this.userLoad === p) this.setUser({ user, isLoading: false });
      },
      () => {
        if (this.userLoad === p) this.setUser({ user: null, isLoading: false });
      },
    );
    return p;
  }

  /** Re-reads the session (after login) and resyncs every active query. */
  async refreshUser(): Promise<ClientUser | null> {
    const u = await this.loadUser(true);
    this.emit({ type: "resync" });
    return u;
  }

  async logout(): Promise<void> {
    await this.request("POST", "/api/auth/logout");
    this.userLoad = Promise.resolve(null);
    this.setUser({ user: null, isLoading: false });
    // A new SSE session (other role) resyncs on connect; without realtime resync directly.
    if (this.sse) this.restartRealtime();
    else this.emit({ type: "resync" });
  }

  // ---------- realtime ----------

  /** Subscribes to invalidation/resync messages; the SSE connection lives while there are subscribers. */
  subscribe(listener: (m: RealtimeMessage) => void): () => void {
    this.listeners.add(listener);
    if (this.realtime && !this.sse) this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  private emit(m: RealtimeMessage): void {
    for (const l of [...this.listeners]) l(m);
  }

  private restartRealtime(): void {
    if (!this.sse) return;
    this.disconnect();
    if (this.listeners.size > 0) this.connect();
  }

  private disconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.sse?.abort();
    this.sse = undefined;
  }

  private connect(): void {
    const ac = new AbortController();
    this.sse = ac;
    void this.stream(ac).finally(() => {
      if (this.sse !== ac || ac.signal.aborted) return;
      // Stream ended or failed: reconnect with backoff while someone is still listening.
      this.sse = undefined;
      if (this.listeners.size === 0) return;
      const delay = Math.min(this.reconnectDelayMs * 2 ** this.attempts, 10_000);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.listeners.size > 0 && !this.sse) this.connect();
      }, delay);
    });
  }

  private async stream(ac: AbortController): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/events`, {
        headers: { Accept: "text/event-stream", "X-Wizard-Request": "1" },
        credentials: "same-origin",
        signal: ac.signal,
      });
      if (!res.ok || !res.body) return;
      this.attempts = 0;
      if (this.connectedOnce) this.emit({ type: "resync" });
      this.connectedOnce = true;
      const parser = new SseParser((event, data) => {
        if (event !== "invalidate") return;
        try {
          const m = JSON.parse(data) as { entity?: unknown; id?: unknown; op?: unknown };
          if (typeof m.entity !== "string") return;
          this.emit({
            type: "invalidate",
            entity: m.entity,
            ...(typeof m.id === "string" ? { id: m.id } : {}),
            ...(m.op === "insert" || m.op === "update" || m.op === "delete" ? { op: m.op } : {}),
          });
        } catch {
          // malformed event: ignore
        }
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      // Some fetch implementations ignore the signal once the body streams: cancel explicitly.
      ac.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        parser.push(value);
      }
    } catch {
      // network error or abort → handled by connect()
    }
  }

  /** Stops realtime and timers (tests, unmount of the provider). */
  close(): void {
    this.listeners.clear();
    this.disconnect();
  }
}
