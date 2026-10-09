// A v3 system for the browser tests of the canvas (V3-06 with V3-03 and V3-04), served by the page routes over the mock
// platform: the real grill interview of @wizard/agents/interview-v3 on the recorded answers of the dental script of
// V3-03 (no model is called) and the real ТЗ reader of V3-04 with the recorded draft answer of its coffee sample. The
// questions go to the page in the platform form (agents/interview-v3.ts platformQuestion: the reserved «Решите за
// меня»), answers come back as POST /answers exactly as platform-api takes them, every turn writes a brief version.
import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import {
  type BriefChange,
  type BriefVersion,
  briefDiagrams,
  briefDiff,
  type SystemBrief,
} from "@wizard/appspec";
import {
  BriefFileError,
  briefGaps,
  extractBriefDraft,
  mergeBriefDraft,
  readBriefFile,
} from "../../../../packages/agents/src/brief-extract/index.js";
import {
  adoptStoredBrief,
  createInterviewV3,
  DELEGATE_LABEL,
  DELEGATE_OPTION_ID,
  type InterviewV3Result,
  type InterviewV3Session,
  newInterviewV3Session,
  type V3Answer,
  type V3PublicQuestion,
} from "../../../../packages/agents/src/interview-v3/index.js";
import { COFFEE } from "../../../../packages/agents/test/brief-extract-fixtures.js";
import {
  DENTAL_SCRIPT,
  PROMPTS,
  scriptedRoute,
} from "../../../../packages/agents/test/interview-v3/helpers.js";
import { ARCHETYPES } from "../../../../packages/ui-kit/src/v3/design/archetypes.js";

type DraftRoute = NonNullable<Parameters<typeof extractBriefDraft>[0]["route"]>;

/** The recorded model answer of the ТЗ sample (V3-04 brief-extract fixtures), one call per chunk. */
const draftRoute: DraftRoute = async () =>
  ({
    tier: "T0",
    model: "gigachat-3.5",
    result: {
      toolCalls: [
        { id: "c1", name: "submit_brief_draft", args: COFFEE.answer as unknown as Record<string, unknown> },
      ],
      finishReason: "tool-calls",
    },
    usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 600 },
    creditsCharged: 0,
    creditsMilli: 0,
    routeReason: "default_T0",
    scrubbed: false,
    ruFallback: false,
  }) as Awaited<ReturnType<DraftRoute>>;

/** The platform form of a v3 question (apps/platform-api/src/agents/interview-v3.ts platformQuestion). */
const platformQuestion = (q: V3PublicQuestion) => ({
  ...q,
  options: [
    ...q.options,
    { id: DELEGATE_OPTION_ID, label: DELEGATE_LABEL, recommended: false, delegate: true },
  ],
});

interface Msg {
  id: string;
  seq: number;
  role: "user" | "assistant";
  kind: string;
  text: string;
  createdAt: string;
}

export class FakeV3 {
  readonly systemId = randomUUID();
  readonly orgId = "00000000-0000-0000-0000-000000000001";
  readonly versions: BriefVersion[] = [];
  readonly answers: unknown[] = [];
  readonly uploads: { name: string; status: number }[] = [];
  stage: "interview" | "card" | "building" = "interview";
  /** «Собрать» bodies (POST /brief/approve) and the build run they started. */
  readonly approvals: unknown[] = [];
  buildRun: string | null = null;
  /** «Три направления» (V3-09): the proposal shown and the picks. */
  readonly picks: unknown[] = [];
  #proposal = fakeProposal();
  question: V3PublicQuestion | null = null;
  readonly messages: Msg[] = [];
  readonly #iv = createInterviewV3({
    // The dental dialog of V3-03 without its web search step (no research tools here).
    route: scriptedRoute(DENTAL_SCRIPT.slice(1)).route,
    orgPolicy: { ruOnly: false, t1Restricted: false },
    ctx: { orgId: "org" },
    research: null,
  });
  #session: InterviewV3Session = newInterviewV3Session();
  #runs = new Map<string, { kind: string; out: "questions" | "answer" | "build" }>();

  latest(): BriefVersion | null {
    return this.versions.at(-1) ?? null;
  }

  #say(role: Msg["role"], kind: string, text: string) {
    this.messages.push({
      id: randomUUID(),
      seq: this.messages.length + 1,
      role,
      kind,
      text,
      createdAt: new Date().toISOString(),
    });
  }

  #write(brief: SystemBrief) {
    const prev = this.latest();
    const diff: BriefChange[] = briefDiff(prev?.brief ?? null, brief);
    if (prev && diff.length === 0) return;
    this.versions.push({
      version: (prev?.version ?? 0) + 1,
      brief,
      diff,
      author: "agent",
      createdAt: new Date().toISOString(),
    });
  }

  /** A turn of the interview → the pending question or the ready brief; a run id the page subscribes to. */
  #turn(res: InterviewV3Result): string {
    this.#session = res.session;
    this.#write(res.session.brief);
    const q = res.outputs.find((o) => o.kind === "question");
    const done = res.outputs.find((o) => o.kind === "brief");
    this.question = q?.kind === "question" ? q.question : null;
    if (done) this.stage = "card";
    const text = res.outputs.find((o) => o.kind !== "notice")?.text ?? "";
    if (text) this.#say("assistant", q ? "questions" : "text", text);
    const run = randomUUID();
    this.#runs.set(run, { kind: "interview_turn", out: q ? "questions" : "answer" });
    return run;
  }

  async start(): Promise<string> {
    this.#say("user", "text", PROMPTS.dental);
    return this.#turn(await this.#iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental }));
  }

  /** POST /answers as platform-api reads it: an own answer, or restByRecommendation — «Дальше решай сам». */
  async answer(body: {
    answers?: { questionId: string; optionId?: string; text?: string }[];
    restByRecommendation?: boolean;
  }) {
    this.answers.push(body);
    const q = this.question;
    if (!q) throw new Error("no pending question");
    const own = body.answers?.[0];
    const a: V3Answer = own
      ? {
          questionId: own.questionId,
          ...(own.optionId ? { optionId: own.optionId } : {}),
          ...(own.text ? { text: own.text } : {}),
        }
      : { questionId: q.id, finish: true };
    const label =
      own?.optionId === DELEGATE_OPTION_ID
        ? DELEGATE_LABEL
        : (q.options.find((o) => o.id === own?.optionId)?.label ??
          own?.text ??
          "остальное — по рекомендациям");
    this.#say("user", "answers", label);
    const latest = this.latest();
    const session = adoptStoredBrief(
      this.#session,
      latest ? { version: latest.version, brief: latest.brief } : null,
    );
    return this.#turn(await this.#iv.answer(session, a));
  }

  /** POST /brief/upload as platform-api answers it (V3-04 upload.ts), with the recorded draft of the sample. */
  async upload(name: string, bytes: Uint8Array): Promise<{ status: number; body: unknown }> {
    let read: Awaited<ReturnType<typeof readBriefFile>>;
    try {
      read = await readBriefFile(bytes);
    } catch (e) {
      if (!(e instanceof BriefFileError)) throw e;
      const code =
        e.httpStatus === 413
          ? "PAYLOAD_TOO_LARGE"
          : e.httpStatus === 415
            ? "UNSUPPORTED_MEDIA_TYPE"
            : "VALIDATION_FAILED";
      this.uploads.push({ name, status: e.httpStatus });
      return { status: e.httpStatus, body: { code, message_ru: e.message, details: { reason: e.code } } };
    }
    const draft = await extractBriefDraft({
      text: read.text,
      route: draftRoute,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "org" },
    });
    const merged = mergeBriefDraft(this.latest()?.brief ?? null, draft.brief);
    const before = this.latest()?.version;
    this.#write(merged);
    const v = this.latest() as BriefVersion;
    this.uploads.push({ name, status: v.version !== before ? 201 : 200 });
    return {
      status: v.version !== before ? 201 : 200,
      body: {
        brief: v,
        diagrams: briefDiagrams(v.brief),
        changed: v.version !== before,
        source: {
          kind: "file",
          format: read.format,
          chars: read.chars,
          truncated: read.truncated,
          ...(read.pages !== undefined ? { pages: read.pages } : {}),
          method: draft.method,
          chunks: draft.chunks,
          answered: draft.answered,
          piiReplaced: draft.pii.found,
        },
        gaps: briefGaps(v.brief),
      },
    };
  }

  system(stageOverride?: string) {
    return {
      id: this.systemId,
      orgId: this.orgId,
      slug: "v3-dental",
      name: "Стоматология",
      stage: stageOverride ?? this.stage,
      draftRevision: 0,
      previewRevision: null,
      createdAt: new Date().toISOString(),
    };
  }

  /** POST /brief/approve (approveSystemBrief): the brief version the owner saw → a build run, or 412. */
  approve(body: { version?: number }): { status: number; body: unknown } {
    this.approvals.push(body);
    const latest = this.latest();
    if (!latest || body.version !== latest.version)
      return {
        status: 412,
        body: {
          code: "VERSION_CONFLICT",
          message_ru: "Бриф изменился",
          details: { version: latest?.version },
        },
      };
    const run = randomUUID();
    this.#runs.set(run, { kind: "build", out: "build" });
    this.buildRun = run;
    this.stage = "building";
    return { status: 202, body: { run: { id: run, kind: "build", status: "queued" }, capCredits: 100 } };
  }

  /** GET /directions and POST /directions/pick of V3-09: the pick goes into the brief (design.archetype, pinned). */
  directions(): unknown {
    return { proposal: this.#proposal };
  }

  pick(body: { proposalId: string; n?: number; skip?: boolean }): { status: number; body: unknown } {
    this.picks.push(body);
    const d = body.n ? this.#proposal.directions[body.n - 1] : this.#proposal.directions[0];
    const latest = this.latest() as BriefVersion;
    this.#write({
      ...latest.brief,
      design: { ...latest.brief.design, archetype: d?.archetype, pinned: !body.skip },
    });
    this.#proposal = { ...this.#proposal, picked: body.skip ? null : (body.n ?? null) };
    return { status: 200, body: { archetype: d?.archetype, pinned: !body.skip } };
  }

  view() {
    return {
      system: this.system(),
      pipeline: "modules",
      card: null,
      pendingQuestions: this.stage === "interview" && this.question ? [platformQuestion(this.question)] : [],
      messages: this.messages,
      activeRunId: this.stage === "building" ? this.buildRun : null,
      publishBlockers: [],
    };
  }

  /** SSE of a turn: started, the chat output, finished. */
  events(runId: string): string {
    const run = this.#runs.get(runId);
    if (!run) return "";
    const ts = new Date().toISOString();
    // A build of the harness v3 keeps running here: its first stage and a line with the money spent so far.
    const list =
      run.out === "build"
        ? [
            { type: "run_started", payload: { kind: "build" } },
            {
              type: "build_stage",
              payload: {
                stage: "skeleton",
                status: "started",
                index: 3,
                total: 8,
                label_ru: "Собираю каркас страниц",
                remainingSec: 900,
              },
            },
            {
              type: "agent_message",
              payload: {
                agent: "builder",
                messageId: "m1",
                text: "Готово: дизайн-система. Сейчас потрачено 42 ₽ из 500 ₽.",
              },
            },
          ]
        : [
            { type: "run_started", payload: { kind: run.kind } },
            { type: "chat_output", payload: { kind: run.out } },
            { type: "run_finished", payload: {} },
          ];
    const frames = list.map((e, i) => ({ runId, seq: i + 1, ts, ...e }));
    return frames.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Serves the v3 system of `fake` to the page: creation, the system, answers, runs, the brief and its upload. */
export async function serveV3(page: Page, fake: FakeV3): Promise<void> {
  const run = (id: string, kind = "interview_turn") => ({
    id,
    systemId: fake.systemId,
    kind,
    status: "queued",
    createdAt: new Date().toISOString(),
  });
  await page.route(/\/api\/v1\/systems$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const id = await fake.start();
    return json(route, 201, { system: fake.system("interview"), run: run(id) });
  });
  await page.route(/\/api\/v1\/runs\/[0-9a-f-]{36}\/events/, async (route) => {
    const id = /\/runs\/([0-9a-f-]{36})\//.exec(route.request().url())?.[1] ?? "";
    const body = fake.events(id);
    if (!body) return route.fallback();
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await page.route(new RegExp(`/api/v1/systems/${fake.systemId}(/.*)?(\\?.*)?$`), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(`/api/v1/systems/${fake.systemId}`, "");
    const latest = fake.latest();
    if (path === "" && req.method() === "GET") return json(route, 200, fake.view());
    if (path === "/answers" && req.method() === "POST") {
      const id = await fake.answer(req.postDataJSON());
      return json(route, 202, { run: run(id) });
    }
    if (path === "/brief/upload" && req.method() === "POST") {
      const buf = req.postDataBuffer() ?? Buffer.alloc(0);
      const file = multipartFile(buf, req.headers()["content-type"] ?? "");
      const r = await fake.upload(file.name, file.bytes);
      return json(route, r.status, r.body);
    }
    if (path === "/brief")
      return json(route, 200, { brief: latest, diagrams: latest ? briefDiagrams(latest.brief) : null });
    if (path === "/brief/versions")
      return json(route, 200, {
        versions: [...fake.versions].reverse().map(({ brief: _b, ...v }) => v),
        nextBefore: null,
      });
    if (path === "/sessions") return json(route, 200, { sessions: [] });
    if (path === "/brief/approve" && req.method() === "POST") {
      const r = fake.approve(req.postDataJSON());
      return json(route, r.status, r.body);
    }
    if (path === "/directions" && req.method() === "GET") return json(route, 200, fake.directions());
    if (path === "/directions/pick" && req.method() === "POST") {
      const r = fake.pick(req.postDataJSON());
      return json(route, r.status, r.body);
    }
    return json(route, 404, { code: "NOT_FOUND", message_ru: "Не найдено" });
  });
}

/** The «file» part of a multipart body: its file name and bytes. */
function multipartFile(body: Buffer, contentType: string): { name: string; bytes: Uint8Array } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const b = `--${boundary?.[1] ?? boundary?.[2] ?? ""}`;
  const start = body.indexOf(b);
  const headEnd = body.indexOf("\r\n\r\n", start);
  const head = body.subarray(start, headEnd).toString("utf8");
  const end = body.indexOf(`\r\n${b}`, headEnd);
  return {
    name: /filename="([^"]*)"/.exec(head)?.[1] ?? "file",
    bytes: new Uint8Array(body.subarray(headEnd + 4, end)),
  };
}

/** A proposal of three directions in the shape of V3-09 (real archetypes, a plain first screen as the preview). */
function fakeProposal() {
  const picks = ARCHETYPES.slice(0, 3);
  return {
    id: "a".repeat(64),
    briefVersion: 1,
    createdAt: new Date().toISOString(),
    costRub: 0,
    fallback: true,
    references: [] as string[],
    picked: null as number | null,
    directions: picks.map((a, i) => ({
      n: i + 1,
      archetype: a.id,
      name: a.name,
      why: a.why,
      texts: { title: "Запись к врачу онлайн", lead: "Выберите врача и время", action: "Записаться" },
      textsSource: "brief" as const,
      tuning: [] as string[],
      header: "simple",
      hero: "split",
      fonts: { display: a.fontPairs[0]?.display ?? "Inter", text: a.fontPairs[0]?.text ?? "Inter" },
      palette: { background: "#ffffff", foreground: "#1d1c1a", accent: "#0f766e" },
      previewHtml: `<!doctype html><html lang="ru"><body style="margin:0;font:24px sans-serif;padding:48px"><h1>${a.name}</h1><p>Запись к врачу онлайн</p></body></html>`,
    })),
  };
}
