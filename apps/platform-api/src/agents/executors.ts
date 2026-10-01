// Real run executors (M0-26): orchestrator for interview turns, runBuild with a QA agent routed through host.route,
// gates G0/G1/G2 (@wizard/gates; G1 and G2 on an in-process runtime in test mode) and the post-G0 draft steps.
import { type BuildCard, runBuild, specDigest } from "@wizard/agents/builder";
import { AgentError } from "@wizard/agents/core";
import { createHostQa, hostRouteFn } from "@wizard/agents/host";
import {
  createOrchestrator,
  newSession,
  type OrchOutput,
  type OrchSession,
  type TurnResult,
} from "@wizard/agents/orchestrator";
import { type RuntimeHandle, runGates } from "@wizard/gates";
import {
  closeExecutors,
  createRuntimeApp,
  MemoryFileStorage,
  MemoryRegistry,
  type RuntimeApp,
  readEnv,
  testModeSecrets,
} from "@wizard/runtime";
import type postgres from "postgres";
import type { Config } from "../config.js";
import {
  type InterviewHost,
  type InterviewOutput,
  RunCancelled,
  type RunExecutors,
  RunFailure,
} from "../runs/types.js";
import { withConsentText } from "./consent.js";
import { bundleDraft, MIGRATOR_ROLE, migrateDraft, RUNTIME_ROLE, seedDraft } from "./draft.js";

export interface AgentExecutorsOptions {
  /** Platform connection: gates (shadow/ephemeral schemas), draft migrations (switching to migratorRole), registry. */
  pg: postgres.Sql;
  config: Config;
  migratorRole?: string;
  runtimeRole?: string;
  /** Runtime for G1 (default: created on first G1 — outbox connectors, test-mode secrets). */
  runtime?: RuntimeApp;
}

const ASKING_HINT = "Ответьте на вопросы выше или нажмите «Остальное — по рекомендациям».";

function lastUserText(host: InterviewHost): string {
  const m = [...host.context.messages].reverse().find((x) => x.role === "user" && x.kind === "text");
  return m?.text ?? "";
}

/** OrchOutput[] of one turn → the single InterviewOutput platform-api persists (+ notice). */
function toOutput(res: TurnResult): InterviewOutput {
  let main: InterviewOutput | undefined;
  let notice: { categories: string[] } | undefined;
  for (const o of res.outputs as OrchOutput[]) {
    if (o.kind === "notice") notice = { categories: o.payload.categories };
    else if (o.kind === "questions")
      main = {
        kind: "questions",
        text: o.text,
        questions: o.questions as unknown as Record<string, unknown>[],
        ...(o.payload.analysis ? { analysis: o.payload.analysis as unknown as Record<string, unknown> } : {}),
      };
    else if (o.kind === "card")
      main = { kind: "card", text: o.text, card: o.card as unknown as Record<string, unknown> };
    else main = { kind: "answer", text: o.text };
  }
  return {
    ...(main ?? { kind: "answer", text: "Готово." }),
    ...(notice ? { notice } : {}),
    state: res.session as unknown as Record<string, unknown>,
  };
}

async function turn(host: InterviewHost): Promise<TurnResult> {
  const c = host.context;
  const orch = createOrchestrator({
    route: hostRouteFn(host.route, { step: "orchestrate" }),
    orgPolicy: c.org.policy,
    ctx: { orgId: c.org.id, runId: host.run.id, systemId: c.system.id },
    org: { plan: c.org.plan as "free" | "start" | "business", ruOnly: c.org.policy.ruOnly },
    runStep: host.runStep,
  });
  let session = (c.state as OrchSession | null) ?? newSession();
  if (c.trigger === "create") return orch.submitBrief(newSession(), lastUserText(host));
  if (c.trigger === "answers") {
    const answers = (c.answers ?? []) as {
      questionId: string;
      optionId?: string;
      text?: string;
      byRecommendation?: boolean;
    }[];
    let res: TurnResult = { session, outputs: [] };
    const outputs: OrchOutput[] = [];
    for (const a of answers.filter((x) => !x.byRecommendation)) {
      res = await orch.answer(res.session, {
        questionId: a.questionId,
        ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
        ...(a.text !== undefined ? { text: a.text } : {}),
      });
      outputs.push(...res.outputs);
      if (res.failure) return { ...res, outputs };
    }
    if (answers.some((x) => x.byRecommendation) && res.session.state === "asking") {
      res = await orch.restByRecommendation(res.session);
      outputs.push(...res.outputs);
    }
    return { ...res, outputs };
  }
  const text = lastUserText(host);
  if (c.system.previewRevision !== null && c.system.stage !== "card") {
    // The system is built: platform stages are the source of truth for the build lifecycle.
    if (session.state !== "done") session = { ...session, state: "done" };
    return orch.requestChange(session, text, {
      specDigest: specDigest(c.spec),
      roles: c.spec.roles.map((r) => r.name),
      entities: c.spec.entities.map((e) => e.name),
    });
  }
  if (session.state === "awaiting_approval") return orch.editCard(session, text);
  if (session.state === "asking")
    return { session, outputs: [{ id: "hint", role: "assistant", kind: "text", text: ASKING_HINT }] };
  return orch.submitBrief(newSession(), text);
}

/** Loads a system into the G1 runtime and remembers it, so the pinned G1 system is unloaded after the gate. */
function trackingHandle(rt: RuntimeApp, loaded: { slug: string; env: "draft" | "prod" }[]): RuntimeHandle {
  return {
    fetch: (req) => rt.fetch(req),
    loadSystem: async (input) => {
      loaded.push({ slug: input.slug ?? input.systemKey, env: input.env });
      return rt.loadSystem(input);
    },
    outbox: () => rt.outbox(),
    runJobs: (input) => rt.runJobs(input),
    env: rt.env,
  };
}

export function createAgentExecutors(o: AgentExecutorsOptions): RunExecutors & { close(): Promise<void> } {
  const runtimeRole = o.runtimeRole ?? RUNTIME_ROLE;
  const migratorRole = o.migratorRole ?? MIGRATOR_ROLE;
  let rt: RuntimeApp | undefined = o.runtime;
  let ownRuntime = false;
  const g1Runtime = (): RuntimeApp => {
    if (!rt) {
      rt = createRuntimeApp({
        db: o.pg,
        registry: new MemoryRegistry(),
        dbRole: runtimeRole,
        connectors: "outbox",
        secrets: testModeSecrets(),
        artifactsRoot: o.config.artifactsDir,
        // G1 systems are ephemeral: their uploads (probes of required file fields) never reach the shared storage.
        files: new MemoryFileStorage(),
        env: {
          ...readEnv(),
          authModeDev: true,
          devLogin: false,
          unsafeLocalExec: o.config.unsafeLocalExec,
          publicScheme: "http",
          platformOrigin: o.config.platformOrigin,
          systemsDomain: "localhost",
        },
      });
      ownRuntime = true;
    }
    return rt;
  };

  return {
    async interviewTurn(host) {
      let res: TurnResult;
      try {
        res = await turn(host);
      } catch (e) {
        if (e instanceof AgentError) return { kind: "answer", text: e.message };
        throw e;
      }
      if (res.failure) throw new RunFailure(res.failure.code, res.failure.message_ru, res.failure.retryable);
      return toOutput(res);
    },

    async build(host, params) {
      const qa = createHostQa(host, { milestone: o.config.milestone });
      const out = await runBuild(
        { ...host, qa },
        { card: params.card as unknown as BuildCard, cap: params.cap, mode: params.mode },
      );
      if (out.status === "succeeded") return { status: "succeeded", summary_ru: out.summary_ru };
      if (out.status === "cancelled") {
        if (out.reason === "aborted") throw new RunCancelled();
        return { status: "cancelled", summary_ru: out.summary_ru };
      }
      throw new RunFailure(out.code, out.message_ru, out.retryable);
    },

    async gates(level, ctx) {
      if (level === "G0") return runGates(level, ctx);
      // G1 and G2 (permission matrix G2-PERM-01…04) run against the same in-process runtime and runtime role.
      const runtime = g1Runtime();
      const loaded: { slug: string; env: "draft" | "prod" }[] = [];
      try {
        return await runGates(level, {
          ...ctx,
          // compliance.consentText from the template (owner-only field, filled by the platform, never stored).
          spec: withConsentText(ctx.spec),
          runtime: trackingHandle(runtime, loaded),
          runtimeRole,
        });
      } finally {
        for (const l of loaded) runtime.unloadSystem(l);
      }
    },

    async onG0Passed(a) {
      const { created } = await migrateDraft(o.pg, {
        systemKey: a.systemKey,
        spec: a.spec,
        prevSpec: a.prevSpec,
        migratorRole,
        runtimeRole,
      });
      if (created) await seedDraft(o.pg, { systemKey: a.systemKey, spec: a.spec, migratorRole });
      // platform.deployments.spec_hash of this revision: the runtime compares it with manifest.specHash.
      const [row] = await o.pg<{ h: string }[]>`
        select encode(sha256(convert_to(spec::text, 'UTF8')), 'hex') as h
        from platform.revisions where system_id = ${a.systemId} and version = ${a.revision}`;
      if (!row) throw new RunFailure("INTERNAL", "Ревизия не найдена", true);
      const { bundleKey } = await bundleDraft({
        artifactsDir: o.config.artifactsDir,
        systemKey: a.systemKey,
        revision: a.revision,
        spec: withConsentText(a.spec),
        files: a.files,
        platformOrigin: o.config.platformOrigin,
        specHash: row.h,
      });
      return { bundleKey };
    },

    async close() {
      if (ownRuntime) await closeExecutors();
    },
  };
}
