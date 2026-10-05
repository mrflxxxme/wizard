// Mock of the M0 platform-api (specs/platform/api.yaml) driven by recorded feeds (test/fixtures/feeds/*.json),
// plus a preview stub on http://<slug>--draft.localhost:<port> that speaks the bridge protocol
// (platform-screens.yaml#preview_contract). One node:http server; the Host header selects API or preview.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  GateReport,
  Message,
  OrgSettings,
  Question,
  Run,
  RunEvent,
  System,
  SystemCard,
  Theme,
} from "../../src/api/types.js";

export interface Feed {
  name: string;
  brief: string;
  system: { name: string; slug: string };
  theme: Theme;
  roles: { name: string; label: string; access: string }[];
  pages: { route: string; title: string; roles: string[] }[];
  interview: { text: string; analysis: Record<string, unknown>; questions: Question[] };
  card: SystemCard;
  cardEdit: { text: string; acceptance: { id: string; text: string } };
  build: { type: string; payload: Record<string, unknown> }[];
  gates: GateReport[];
}

export const loadFeed = (name: "forum" | "bakery"): Feed =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/feeds", `${name}.json`), "utf8")) as Feed;

export interface MockOptions {
  feed: Feed;
  /** Origin of the platform page (the preview stub accepts messages only from it). */
  platformOrigin: string;
  variant?: "budget" | "failG1" | "failBuild";
  eventDelayMs?: number;
  orgSettings?: OrgSettings | null;
}

interface SysState {
  system: System;
  messages: Message[];
  pendingQuestions: Question[];
  card: SystemCard | null;
  theme: Theme;
  gates: GateReport[] | null;
  publishBlockers: string[];
  activeRunId: string | null;
}

interface RunState {
  run: Run;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  waiting: { inputId: string; resume(choice: string): void } | null;
  cancelled: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const PHONE = /\+7[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g;
const ORG = "00000000-0000-0000-0000-000000000001";
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mask(text: string): string {
  return text.replace(PHONE, (m) => {
    const d = m.replace(/\D/g, "");
    return `+7 ${d.slice(1, 4)} ••• ${d.slice(7, 9)} ${d.slice(9, 11)}`;
  });
}

export class MockPlatform {
  readonly opts: MockOptions;
  readonly requests: RecordedRequest[] = [];
  readonly systems = new Map<string, SysState>();
  readonly runs = new Map<string, RunState>();
  previewRole: string;
  previewLogins = 0;
  port = 0;
  #server: Server;
  #sockets = new Set<ServerResponse>();

  constructor(opts: MockOptions) {
    this.opts = opts;
    this.previewRole =
      opts.feed.roles.find((r) => r.access === "public")?.name ?? opts.feed.roles[0]?.name ?? "";
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "INTERNAL", message_ru: String(e) }));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", () => r()));
    const a = this.#server.address();
    this.port = typeof a === "object" && a ? a.port : 0;
    return this;
  }

  async close(): Promise<void> {
    this.dropStreams();
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  get apiTarget(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get previewOrigin(): string {
    return `http://${this.opts.feed.system.slug}--draft.localhost:${this.port}`;
  }

  /** Breaks every open SSE connection (network failure simulation). */
  dropStreams(): void {
    for (const res of this.#sockets) res.destroy();
    this.#sockets.clear();
  }

  countRequests(method: string, re: RegExp): number {
    return this.requests.filter((r) => r.method === method && re.test(r.path)).length;
  }

  // ---------------------------------------------------------------- runs

  #newRun(sys: SysState, kind: Run["kind"], mode?: Run["mode"]): RunState {
    const run: Run = {
      id: randomUUID(),
      systemId: sys.system.id,
      kind,
      ...(mode ? { mode } : {}),
      status: "queued",
      credits: { used: 0 },
      lastEventSeq: 0,
      createdAt: now(),
    };
    const st: RunState = { run, events: [], listeners: new Set(), waiting: null, cancelled: false };
    this.runs.set(run.id, st);
    sys.activeRunId = run.id;
    return st;
  }

  #emit(st: RunState, type: string, payload: Record<string, unknown>): void {
    const e: RunEvent = { runId: st.run.id, seq: st.events.length + 1, type, ts: now(), payload };
    st.events.push(e);
    st.run.lastEventSeq = e.seq;
    if (type === "run_finished" || type === "run_failed") {
      st.run.status =
        type === "run_failed" ? "failed" : payload.status === "cancelled" ? "cancelled" : "succeeded";
      const sys = [...this.systems.values()].find((s) => s.activeRunId === st.run.id);
      if (sys) sys.activeRunId = null;
    } else if (type === "needs_input") st.run.status = "needs_input";
    else st.run.status = "running";
    for (const l of st.listeners) l(e);
  }

  #message(sys: SysState, m: Omit<Message, "id" | "seq" | "createdAt">): Message {
    const msg: Message = { id: randomUUID(), seq: sys.messages.length + 1, createdAt: now(), ...m };
    sys.messages.push(msg);
    return msg;
  }

  async #interview(
    sys: SysState,
    st: RunState,
    body: (emit: (t: string, p: Record<string, unknown>) => void) => void,
  ) {
    await sleep(this.opts.eventDelayMs ?? 30);
    this.#emit(st, "run_started", { kind: "interview_turn", mode: null, baseRevision: null, credits: null });
    await sleep(this.opts.eventDelayMs ?? 30);
    body((t, p) => this.#emit(st, t, p));
    await sleep(this.opts.eventDelayMs ?? 30);
    this.#emit(st, "budget_update", { used: 0.4, cap: 2 });
    this.#emit(st, "run_finished", {
      status: "succeeded",
      resultRevision: null,
      creditsUsed: 0.4,
      summary_ru: "",
    });
    void sys;
  }

  #buildEvents(): { type: string; payload: Record<string, unknown> }[] {
    const events = structuredClone(this.opts.feed.build);
    const v = this.opts.variant;
    if (v === "budget") {
      const cap = 6;
      for (const e of events) {
        if (e.type === "run_started") (e.payload.credits as Record<string, number>).cap = cap;
        if (e.type === "budget_update") e.payload.cap = cap;
      }
      const at = events.findIndex(
        (e, i) =>
          e.type === "step_finished" &&
          events.slice(0, i).filter((x) => x.type === "step_finished").length === 1,
      );
      events.splice(
        at + 1,
        0,
        { type: "budget_exceeded", payload: { used: cap, cap, nextStep: "P3" } },
        {
          type: "needs_input",
          payload: {
            inputId: "budget-1",
            kind: "decision",
            decisionId: "budget",
            prompt_ru: "Потолок кредитов достигнут. Что делаем?",
            options: [
              { id: "raise_cap_2", label: "Поднять потолок на 2 кредита", recommended: true },
              { id: "stop", label: "Остановить сборку" },
            ],
          },
        },
      );
    }
    if (v === "failG1") {
      const g1 = events.find((e) => e.type === "gate_result" && e.payload.level === "G1");
      if (g1) {
        g1.payload.passed = false;
        g1.payload.failedChecks = [
          {
            id: "G1-AC2",
            message_ru: "Партнёр видит чужую квоту",
            file: "functions/partnerQuota.ts",
            line: 12,
          },
        ];
      }
    }
    if (v === "failBuild") {
      const at = events.findIndex((e) => e.type === "gate_started" && e.payload.level === "G1");
      events.splice(at, events.length - at, {
        type: "run_failed",
        payload: {
          code: "GATES_FAILED",
          message_ru: "Сборка не прошла проверки. Можно попросить исправить.",
          retryable: false,
          lastGoodRevision: 1,
        },
      });
    }
    return events;
  }

  async #build(sys: SysState, st: RunState, events: { type: string; payload: Record<string, unknown> }[]) {
    const delay = this.opts.eventDelayMs ?? 30;
    for (const e of events) {
      await sleep(delay);
      if (st.cancelled) {
        this.#emit(st, "run_finished", {
          status: "cancelled",
          resultRevision: null,
          creditsUsed: 1,
          summary_ru: "Сборка остановлена",
        });
        sys.system.stage = "failed";
        return;
      }
      if (e.type === "needs_input") {
        const choice = await new Promise<string>((resolve) => {
          st.waiting = { inputId: String(e.payload.inputId), resume: resolve };
          this.#emit(st, e.type, e.payload);
        });
        st.waiting = null;
        this.#emit(st, "input_received", { inputId: e.payload.inputId, choice });
        if (choice === "stop") {
          this.#emit(st, "run_finished", {
            status: "cancelled",
            resultRevision: null,
            creditsUsed: 6,
            summary_ru: "Сборка остановлена",
          });
          sys.system.stage = "failed";
          return;
        }
        continue;
      }
      if (e.type === "gate_result" && e.payload.level === "G0" && e.payload.passed === true) {
        const rev = Number(e.payload.revision);
        sys.system.draftRevision = Math.max(sys.system.draftRevision, rev);
        sys.system.previewRevision = rev;
      }
      if (e.type === "run_finished") {
        sys.gates = this.#reports();
        sys.publishBlockers = sys.gates.some((g) => !g.passed) ? ["GATES_FAILED"] : [];
        sys.system.stage = "ready";
        this.#message(sys, {
          role: "assistant",
          kind: "run_report",
          text: String(e.payload.summary_ru ?? ""),
          runId: st.run.id,
          payload: { runId: st.run.id, status: "succeeded" },
        });
      }
      if (e.type === "run_failed") {
        sys.gates = this.#reports().slice(0, 1);
        sys.system.stage = "failed";
      }
      this.#emit(st, e.type, e.payload);
    }
  }

  #reports(): GateReport[] {
    const reports = structuredClone(this.opts.feed.gates);
    if (this.opts.variant === "failG1") {
      const g1 = reports.find((r) => r.level === "G1");
      if (g1) {
        g1.passed = false;
        g1.checks.push({
          id: "G1-AC2-fail",
          status: "fail",
          severity: "blocker",
          message_ru: "Партнёр видит чужую квоту",
          file: "functions/partnerQuota.ts",
          line: 12,
        });
      }
    }
    return reports;
  }

  // ---------------------------------------------------------------- HTTP

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const host = (req.headers.host ?? "").toLowerCase();
    const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);
    if (host.includes("--draft.localhost")) return this.#preview(req, res, url);
    const raw = await new Promise<string>((resolve) => {
      let b = "";
      req.setEncoding("latin1");
      req.on("data", (c: string) => {
        b += c;
      });
      req.on("end", () => resolve(b));
    });
    let body: unknown = null;
    if ((req.headers["content-type"] ?? "").includes("application/json") && raw)
      body = JSON.parse(Buffer.from(raw, "latin1").toString("utf8"));
    this.requests.push({
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const fail = (status: number, code: string, message_ru: string) => json(status, { code, message_ru });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    const b = (body ?? {}) as Record<string, unknown>;

    if (req.method === "GET" && p === "/systems")
      return json(200, {
        items: [...this.systems.values()].map((s) => s.system).reverse(),
        nextCursor: null,
      });
    if (req.method === "POST" && p === "/systems") return json(201, this.#create(String(b.prompt ?? "")));
    // M1 accounts (M1-11): the local user owns the local organization.
    if (req.method === "GET" && p === "/me")
      return json(200, {
        user: { id: "00000000-0000-4000-8000-00000000d001", email: "dev@wizard.local", name: null },
        memberships: [{ orgId: ORG, orgName: "Локальная организация", role: "owner" }],
      });
    if (req.method === "GET" && /^\/orgs\/[^/]+\/members$/.test(p))
      return json(200, {
        items: [{ userId: "00000000-0000-4000-8000-00000000d001", email: "dev@wizard.local", role: "owner" }],
      });
    // D70 (M2-56): a pilot org — «На пилоте бесплатно» and what is left; D68: «Написать команде».
    if (req.method === "GET" && /^\/orgs\/[^/]+$/.test(p))
      return json(200, { id: ORG, name: "Локальная организация", plan: "pilot", paymentsEnabled: false });
    if (req.method === "GET" && /^\/orgs\/[^/]+\/usage$/.test(p))
      return json(200, {
        pilot: true,
        free: true,
        builds: { limit: 5, used: 3, left: 2, nextAt: null },
        edits: { limit: 20, used: 5, left: 15, nextAt: null },
      });
    if (req.method === "POST" && p === "/support/requests")
      return json(201, {
        id: "00000000-0000-4000-8000-0000000000aa",
        replyBy: "2026-10-05T12:00:00.000Z",
        message_ru: "Сообщение отправлено.",
      });
    if (/^\/orgs\/([^/]+)\/settings$/.test(p)) {
      return this.opts.orgSettings ? json(200, this.opts.orgSettings) : fail(404, "NOT_FOUND", "Не найдено");
    }
    const sm = /^\/systems\/([^/]+)(\/.*)?$/.exec(p);
    if (sm) {
      const m = sm;
      const sys = this.systems.get(m[1] as string);
      if (!sys) return fail(404, "NOT_FOUND", "Система не найдена");
      const rest = m[2] ?? "";
      return this.#system(req.method ?? "GET", rest, sys, b, url, json, fail);
    }
    const rm = /^\/runs\/([^/]+)(\/.*)?$/.exec(p);
    if (rm) {
      const m = rm;
      const st = this.runs.get(m[1] as string);
      if (!st) return fail(404, "NOT_FOUND", "Прогон не найден");
      const rest = m[2] ?? "";
      if (req.method === "GET" && rest === "") return json(200, st.run);
      if (req.method === "GET" && rest === "/events") return this.#sse(req, res, st, url);
      if (req.method === "POST" && rest === "/cancel") {
        st.cancelled = true;
        return json(202, st.run);
      }
      if (req.method === "POST" && rest === "/input") {
        if (!st.waiting || st.waiting.inputId !== b.inputId)
          return fail(409, "RUN_NOT_WAITING_INPUT", "Прогон не ждёт ответа");
        st.waiting.resume(String(b.choice ?? ""));
        return json(202, st.run);
      }
    }
    return fail(404, "NOT_FOUND", "Не найдено");
  }

  #create(prompt: string) {
    const feed = this.opts.feed;
    const id = randomUUID();
    const sys: SysState = {
      system: {
        id,
        orgId: ORG,
        slug: feed.system.slug,
        name: "",
        stage: "interview",
        draftRevision: 0,
        previewRevision: null,
        prodRevision: null,
        prodUrl: null,
        suspended: false,
        createdAt: now(),
      },
      messages: [],
      pendingQuestions: [],
      card: null,
      theme: structuredClone(feed.theme),
      gates: null,
      publishBlockers: [],
      activeRunId: null,
    };
    this.systems.set(id, sys);
    const hasPhone = PHONE.test(prompt);
    PHONE.lastIndex = 0;
    const user = this.#message(sys, {
      role: "user",
      kind: "text",
      text: prompt,
      ...(hasPhone ? { payload: { maskedText: mask(prompt) } } : {}),
    });
    const st = this.#newRun(sys, "interview_turn");
    void this.#interview(sys, st, (emit) => {
      if (hasPhone) {
        const n = this.#message(sys, {
          role: "system",
          kind: "notice",
          payload: { type: "pii", categories: ["phone"] },
          runId: st.run.id,
        });
        emit("chat_output", { kind: "notice", messageId: n.id });
      }
      emit("agent_message", { agent: "orchestrator", messageId: "a1", text: "Разбираю задачу" });
      const q = this.#message(sys, {
        role: "assistant",
        kind: "questions",
        text: feed.interview.text,
        payload: {
          questionIds: feed.interview.questions.map((x) => x.id),
          analysis: feed.interview.analysis,
        },
        runId: st.run.id,
      });
      sys.pendingQuestions = structuredClone(feed.interview.questions);
      emit("chat_output", { kind: "questions", messageId: q.id });
    });
    void user;
    return { system: sys.system, run: st.run };
  }

  #system(
    method: string,
    rest: string,
    sys: SysState,
    b: Record<string, unknown>,
    url: URL,
    json: (s: number, d: unknown) => void,
    fail: (s: number, c: string, m: string) => void,
  ): unknown {
    const feed = this.opts.feed;
    if (method === "GET" && rest === "") {
      return json(200, {
        system: sys.system,
        card: sys.card,
        pendingQuestions: sys.pendingQuestions,
        messages: sys.messages,
        activeRunId: sys.activeRunId,
        publishBlockers: sys.publishBlockers,
      });
    }
    if (method === "POST" && rest === "/answers") {
      if (sys.system.stage !== "interview") return fail(409, "SYSTEM_LOCKED", "Сейчас нельзя");
      this.#message(sys, { role: "user", kind: "answers", text: "Ответы приняты", payload: b });
      sys.pendingQuestions = [];
      const st = this.#newRun(sys, "interview_turn");
      void this.#interview(sys, st, (emit) => {
        sys.card = structuredClone(feed.card);
        sys.system.stage = "card";
        sys.system.name = feed.system.name;
        const c = this.#message(sys, {
          role: "assistant",
          kind: "card",
          payload: { cardVersion: 1 },
          runId: st.run.id,
        });
        emit("chat_output", { kind: "card", messageId: c.id, cardVersion: 1 });
      });
      return json(202, { run: st.run });
    }
    if (method === "POST" && rest === "/messages") {
      if (sys.system.stage === "building")
        return fail(409, "SYSTEM_LOCKED", "Правки можно отправить после сборки");
      const message = this.#message(sys, { role: "user", kind: "text", text: String(b.text ?? "") });
      const st = this.#newRun(sys, "interview_turn");
      void this.#interview(sys, st, (emit) => {
        if (sys.system.stage === "card" && sys.card) {
          const next = structuredClone(sys.card);
          next.cardVersion += 1;
          next.acceptance = [...(next.acceptance ?? []), feed.cardEdit.acceptance];
          sys.card = next;
          const c = this.#message(sys, {
            role: "assistant",
            kind: "card",
            payload: { cardVersion: next.cardVersion },
            runId: st.run.id,
          });
          emit("chat_output", { kind: "card", messageId: c.id, cardVersion: next.cardVersion });
        } else {
          const a = this.#message(sys, {
            role: "assistant",
            kind: "text",
            text: "Понял, учту.",
            runId: st.run.id,
          });
          emit("chat_output", { kind: "answer", messageId: a.id });
        }
      });
      return json(202, { message, run: st.run });
    }
    if (method === "POST" && rest === "/card/approve") {
      if (!sys.card) return fail(409, "NO_CARD", "Нет карточки");
      if (b.cardVersion !== sys.card.cardVersion)
        return fail(409, "CARD_VERSION_STALE", "Карточка изменилась");
      sys.system.stage = "building";
      const st = this.#newRun(sys, "build", "create");
      void this.#build(sys, st, this.#buildEvents());
      return json(202, { run: st.run });
    }
    if (method === "POST" && rest === "/fix") {
      sys.system.stage = "building";
      const st = this.#newRun(sys, "build", "fix");
      const tail = this.opts.feed.build.filter(
        (e) => e.type.startsWith("gate_") || e.type === "run_finished",
      );
      void this.#build(sys, st, [
        {
          type: "run_started",
          payload: { kind: "build", mode: "fix", baseRevision: 1, credits: { estimate: 3, cap: 5 } },
        },
        { type: "step_started", payload: { step: "fix", label_ru: "Исправляю ошибки проверок", attempt: 1 } },
        { type: "step_finished", payload: { step: "fix", durationMs: 1000 } },
        ...tail,
      ]);
      return json(202, { run: st.run });
    }
    if (method === "GET" && rest === "/lock") return json(200, { held: false, queue: [] });
    const m = /^\/revisions\/(\d+)$/.exec(rest);
    if (method === "GET" && m) {
      return json(200, {
        version: Number(m[1]),
        author: "agent",
        kind: "ops",
        createdAt: now(),
        spec: { theme: sys.theme },
        ops: [],
        files: [],
      });
    }
    if (method === "POST" && rest === "/style") {
      if (sys.system.stage === "building") return fail(409, "SYSTEM_LOCKED", "Сейчас идёт сборка");
      if (b.expectedVersion !== sys.system.draftRevision)
        return fail(412, "VERSION_CONFLICT", "Версия изменилась");
      sys.theme = (b.theme ?? {}) as Theme;
      sys.system.draftRevision += 1;
      return json(200, {
        revision: { version: sys.system.draftRevision, author: "user", kind: "style", createdAt: now() },
      });
    }
    if (method === "POST" && rest === "/assets") {
      sys.system.draftRevision += 1;
      sys.theme = { ...sys.theme, logoFile: "assets/logo.png" };
      return json(201, {
        path: "assets/logo.png",
        sha256: "0".repeat(64),
        revision: { version: sys.system.draftRevision, author: "user", kind: "style", createdAt: now() },
      });
    }
    if (method === "GET" && rest === "/preview-url") {
      if (sys.system.previewRevision == null) return fail(409, "PREVIEW_NOT_READY", "Превью ещё не готово");
      const role =
        url.searchParams.get("role") ?? this.opts.feed.roles.find((r) => r.access === "public")?.name ?? "";
      return json(200, {
        url: `${this.previewOrigin}/_wizard/dev-login?role=${encodeURIComponent(role)}&next=/`,
        revision: sys.system.previewRevision,
        roles: feed.roles.map((r) => ({ name: r.name, label: r.label })),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    }
    if (method === "GET" && rest === "/gates/latest") {
      if (!sys.gates) return fail(404, "NOT_FOUND", "Отчётов нет");
      return json(200, { revision: sys.system.draftRevision, reports: sys.gates });
    }
    return fail(404, "NOT_FOUND", "Не найдено");
  }

  #sse(req: IncomingMessage, res: ServerResponse, st: RunState, url: URL): void {
    const after =
      Math.max(Number(url.searchParams.get("after") ?? 0), Number(req.headers["last-event-id"] ?? 0)) || 0;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    this.#sockets.add(res);
    const write = (e: RunEvent) => {
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (e.type === "run_finished" || e.type === "run_failed") {
        st.listeners.delete(write);
        this.#sockets.delete(res);
        res.end();
      }
    };
    for (const e of st.events.filter((x) => x.seq > after)) {
      write(e);
      if (res.writableEnded) return;
    }
    st.listeners.add(write);
    res.on("close", () => {
      st.listeners.delete(write);
      this.#sockets.delete(res);
    });
  }

  // ---------------------------------------------------------------- preview stub (runtime draft host)

  #current(): SysState | undefined {
    return [...this.systems.values()].at(-1);
  }

  #preview(_req: IncomingMessage, res: ServerResponse, url: URL): unknown {
    const feed = this.opts.feed;
    if (url.pathname === "/_wizard/dev-login") {
      const role = url.searchParams.get("role") ?? "";
      if (feed.roles.some((r) => r.name === role)) this.previewRole = role;
      this.previewLogins++;
      const next = url.searchParams.get("next") ?? "/";
      res.writeHead(302, { location: /^\/(?![/\\])/.test(next) ? next : "/", "cache-control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/_wizard/stub.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(STUB_JS);
    }
    const sys = this.#current();
    const theme = sys?.theme ?? {};
    const pages = feed.pages.filter((p) => p.roles.includes(this.previewRole) && !p.route.includes(":"));
    const config = {
      platformOrigin: this.opts.platformOrigin,
      revision: sys?.system.previewRevision ?? 0,
      role: this.previewRole,
      pages,
    };
    const accent = /^#[0-9a-f]{6}$/i.test(theme.accent ?? "") ? theme.accent : "#2F46D8";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><html lang="ru" data-wz-mode="${theme.mode ?? "auto"}" style="--w-accent:${accent};--w-accent-ink:#ffffff">
<head><meta charset="utf-8"><title>${feed.system.name}</title>
<style>body{font-family:system-ui;margin:0;padding:16px}nav a{margin-right:12px}.cta{background:var(--w-accent);color:var(--w-accent-ink);border:0;padding:10px 16px;border-radius:8px}</style>
<script id="wz-config" type="application/json">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
<script src="/_wizard/stub.js" defer></script></head>
<body><nav data-testid="stub-nav"></nav><main><h1 data-testid="stub-route"></h1><button class="cta" data-testid="stub-cta">Зарегистрироваться</button></main></body></html>`);
  }
}

/** Preview stub: renders nav of the current role and speaks the bridge protocol like apps/runtime bridge.js. */
const STUB_JS = `(() => {
  const cfg = JSON.parse(document.getElementById("wz-config").textContent);
  const parent = window.parent;
  const post = (type, payload, id) => { const m = { wz: 1, type, payload }; if (id) m.id = id; parent.postMessage(m, cfg.platformOrigin); };
  const route = () => location.pathname + location.search;
  const render = () => {
    const nav = document.querySelector("nav");
    nav.textContent = "";
    for (const p of cfg.pages) {
      const a = document.createElement("a");
      a.href = p.route; a.textContent = p.title; a.dataset.testid = "stub-nav-item";
      a.addEventListener("click", (e) => { e.preventDefault(); history.pushState(null, "", p.route); render(); post("route-changed", { route: route() }); });
      nav.appendChild(a);
    }
    document.querySelector("h1").textContent = location.pathname;
  };
  window.addEventListener("message", (e) => {
    if (e.origin !== cfg.platformOrigin || e.source !== parent) return;
    const m = e.data;
    if (!m || m.wz !== 1) return;
    if (m.type === "apply-theme-tokens") {
      for (const [k, v] of Object.entries(m.payload.tokens || {})) if (/^--w-[a-z0-9-]+$/.test(k)) document.documentElement.style.setProperty(k, v);
      document.documentElement.setAttribute("data-wz-mode", m.payload.mode);
      post("theme-applied", {}, m.id);
    } else if (m.type === "set-role") {
      const u = new URL(m.payload.url, location.href);
      if (u.origin !== location.origin) return;
      u.searchParams.set("next", route());
      sessionStorage.setItem("wz-pending", m.id || "");
      location.replace(u.pathname + u.search);
    } else if (m.type === "navigate") {
      history.pushState(null, "", m.payload.route); render();
    }
  });
  render();
  const pending = sessionStorage.getItem("wz-pending") || undefined;
  sessionStorage.removeItem("wz-pending");
  post("ready", { protocol: 1, route: route(), role: cfg.role, revision: cfg.revision }, pending);
})();
`;
