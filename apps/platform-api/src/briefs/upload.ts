// POST /systems/:id/brief/upload (V3-04, D77 (8), builder-v3.md §3 C1): the owner's ТЗ file (docx, pdf, md, txt ≤ 10 МБ,
// the format by signature) → a draft of the system brief. The file lives only in the memory of this request: its text is
// extracted here, on the platform server in the RF, sent to the T0-only call brief_extract
// (data-boundary.yaml#call_types.brief_extract) and dropped; neither the bytes nor the file name are written anywhere.
// The draft (scrubbed of personal data) fills only the empty sections of the latest brief and becomes a new version with
// author agent; an assumption names the source. Without a model (fixture miss, LLM cap of the month, demo replay,
// errors) the heuristic draft is used. The answer carries briefGaps — what the interview still has to ask.
import {
  BRIEF_FILE_LIMITS,
  type BriefDraftResult,
  BriefFileError,
  type BriefFileText,
  briefGaps,
  extractBriefDraft,
  mergeBriefDraft,
  readBriefFile,
} from "@wizard/agents/brief-extract";
import { BRIEF_LIMITS, briefDiagrams, type SystemBrief } from "@wizard/appspec";
import {
  CircuitBreaker,
  createRegistry,
  createRouter,
  type LlmMode,
  type RouteInput,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import type { Deps } from "../http/util.js";
import type { OpsAlertFn } from "../ops/alert.js";
import { orgDemoReplay } from "../runs/demo-replay.js";
import { reportProviderDegraded } from "../runs/models-outage.js";
import { orgPolicyOf } from "../runs/queue.js";
import { DbUsageSink } from "../runs/usage.js";
import { BriefConflictError, BriefInvalidError, getLatestBrief, saveBriefVersion } from "./store.js";

/** Multipart overhead allowed on top of the file (boundaries, headers, the baseVersion field). */
const MULTIPART_SLACK = 1024 * 1024;
/** Fixture of brief_extract in fixture mode (env WIZARD_BRIEF_FIXTURE=<suite>/<name>). */
export const DEFAULT_BRIEF_FIXTURE = "unit/brief-extract";

const FORMAT_LABEL: Record<BriefFileText["format"], string> = { docx: "DOCX", pdf: "PDF", text: "текст" };

/** The assumption that marks where a draft came from (deduplicated by text). */
export const sourceNote = (format: BriefFileText["format"]) =>
  `Черновик брифа составлен по файлу ТЗ (${FORMAT_LABEL[format]}); разделы, которых нет в ТЗ, уточняются в интервью`;

const tooLarge = () =>
  new ApiError("PAYLOAD_TOO_LARGE", "Файл больше 10 МБ — сократите ТЗ или пришлите его частями", {
    reason: "FILE_TOO_LARGE",
  });

function fileError(e: BriefFileError): ApiError {
  if (e.httpStatus === 413) return new ApiError("PAYLOAD_TOO_LARGE", e.message, { reason: e.code });
  if (e.httpStatus === 415) return new ApiError("UNSUPPORTED_MEDIA_TYPE", e.message, { reason: e.code });
  return invalid(e.message, { reason: e.code });
}

export interface BriefUploadDeps extends Pick<Deps, "db" | "config" | "billing"> {
  createRouter?: (opts: RouterOptions) => Router;
  /** Founder alerts (D76: an empty provider balance, an opened model breaker). */
  alert?: OpsAlertFn;
  log?: (msg: string, err?: unknown) => void;
}

export function briefUploadRoutes(d: BriefUploadDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const circuit = new CircuitBreaker();
  let router: Router | null = null;

  /** One router for the uploads of this process; live only with WIZARD_LLM_MODE=live (as the runtime AI gateway). */
  function getRouter(): Router {
    if (router) return router;
    const mode: LlmMode = process.env.WIZARD_LLM_MODE === "live" ? "live" : "fixture";
    const [suite, name] = (process.env.WIZARD_BRIEF_FIXTURE || DEFAULT_BRIEF_FIXTURE).split("/");
    router = (d.createRouter ?? createRouter)({
      mode,
      registry: createRegistry({ buildDefaultTier: d.config.buildDefaultTier }),
      sink: new DbUsageSink(d.db),
      circuit,
      onProviderDegraded: (event) => {
        reportProviderDegraded({ db: d.db, event, alert: d.alert }).catch((err) =>
          d.log?.("provider_degraded alert", err),
        );
      },
      ...(mode === "fixture"
        ? {
            fixture: {
              suite: suite === "eval" || suite === "demo" ? suite : "unit",
              name: name || "brief-extract",
              lenient: process.env.WIZARD_FIXTURE_LENIENT === "1",
            },
          }
        : {}),
    });
    return router;
  }

  async function loadSystem(user: AuthUser, id: string | undefined) {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "editor", "Система");
    return s;
  }

  /** The model's draft, or the heuristic one when the model may not or cannot be called (the reason in `note`). */
  async function draftOf(
    s: { id: string; org_id: string },
    text: string,
    signal: AbortSignal,
  ): Promise<BriefDraftResult> {
    if (await orgDemoReplay(d.db, s.org_id)) return extractBriefDraft({ text });
    try {
      await d.billing.assertLlmBudget(s.org_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "LLM_BUDGET_EXHAUSTED") return extractBriefDraft({ text });
      throw e;
    }
    const org = await d.db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted", "region_code"])
      .where("id", "=", s.org_id)
      .executeTakeFirstOrThrow();
    let rt: Router;
    try {
      rt = getRouter();
    } catch (e) {
      d.log?.("brief upload: router unavailable", e);
      return extractBriefDraft({ text });
    }
    return extractBriefDraft({
      text,
      route: (input: RouteInput) => rt.route(input),
      orgPolicy: orgPolicyOf(org),
      ctx: { orgId: s.org_id, systemId: s.id, step: "brief_extract" },
      signal,
    });
  }

  r.post(
    "/systems/:id/brief/upload",
    bodyLimit({
      maxSize: BRIEF_FILE_LIMITS.fileBytes + MULTIPART_SLACK,
      onError: () => {
        throw tooLarge();
      },
    }),
    async (c) => {
      const user = c.get("user");
      const s = await loadSystem(user, c.req.param("id"));
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw invalid("Ожидается multipart/form-data с файлом ТЗ");
      }
      const file = form.file;
      if (!(file instanceof File)) throw invalid("Нет файла ТЗ (поле file)");
      if (file.size > BRIEF_FILE_LIMITS.fileBytes) throw tooLarge();
      let read: BriefFileText;
      try {
        read = await readBriefFile(new Uint8Array(await file.arrayBuffer()));
      } catch (e) {
        if (e instanceof BriefFileError) throw fileError(e);
        throw e;
      }
      const draft = await draftOf(s, read.text, c.req.raw.signal);
      if (draft.method === "heuristic" && draft.note)
        d.log?.(`brief upload: heuristic draft (${draft.note})`);

      // The draft fills the empty sections of the latest version; a concurrent edit → read again and merge once more.
      const save = async () => {
        const latest = await getLatestBrief(d.db, s.id);
        const merged: SystemBrief = mergeBriefDraft(latest?.brief ?? null, draft.brief);
        const note = sourceNote(read.format);
        if (
          !merged.assumptions.some((a) => a.text === note) &&
          merged.assumptions.length < BRIEF_LIMITS.assumptions
        )
          merged.assumptions.push({ text: note, source: "default" });
        return saveBriefVersion(d.db, {
          systemId: s.id,
          brief: merged,
          author: "agent",
          baseVersion: latest?.version ?? 0,
        });
      };
      let saved: Awaited<ReturnType<typeof saveBriefVersion>>;
      try {
        saved = await save().catch((e) => {
          if (e instanceof BriefConflictError) return save();
          throw e;
        });
      } catch (e) {
        if (e instanceof BriefInvalidError)
          throw new ApiError(
            "VALIDATION_FAILED",
            e.errors[0]?.message_ru ?? "Черновик брифа не прошёл проверку",
            {
              errors: e.errors,
            },
          );
        if (e instanceof BriefConflictError)
          throw new ApiError("VERSION_CONFLICT", "Бриф изменился — приложите ТЗ ещё раз", {
            version: e.latest,
          });
        throw e;
      }
      return c.json(
        {
          brief: saved.version,
          diagrams: briefDiagrams(saved.version.brief),
          changed: saved.changed,
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
          gaps: briefGaps(saved.version.brief),
        },
        saved.changed ? 201 : 200,
      );
    },
  );

  return r;
}
