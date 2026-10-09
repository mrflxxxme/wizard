// «Три направления» on the platform (V3-09; api.yaml /systems/{id}/directions*): proposals from the current brief, the
// owner's words, the pick and the references. A proposal is stored as a content-addressed blob (its sha256 is its id
// and the capability of its preview files) and announced in the system chat (assistant message, payload type
// design_directions); the pick and the references become new brief versions (V3-02 store, author owner). Model calls
// go through the platform router with the org policy (T1 only scrubbed, models.yaml) and the LLM cap; a missing model
// or budget never blocks the step — the texts then come from the brief.
import { randomUUID } from "node:crypto";
import {
  DIRECTIONS_BUDGET_RUB,
  type DirectionsModel,
  type DirectionsProposal,
  directionDesign,
  directionsNiche,
  isDirectionsProposal,
  LOGO_HEAD,
  logoPrinciples,
  pagePrinciples,
  pickedDesign,
  proposeDirections,
  type RefineResult,
  RUB_PER_CREDIT,
  RubWallet,
  referenceLine,
  refineDirections,
  screenshotPrinciples,
  tuningWords,
  WORDS_HEAD,
} from "@wizard/agents/builder";
import {
  createResearch,
  guardedTransport,
  ResearchError,
  type ResearchFetch,
  type ResearchMode,
  researchMode,
  systemResolver,
} from "@wizard/agents/research";
import type { BriefVersion, SystemBrief } from "@wizard/appspec";
import { createRegistry, createRouter, type LlmMode, type Router, type RouterOptions } from "@wizard/llm";
import { cssHex } from "@wizard/ui-kit/v3/design";
import { sql } from "kysely";
import type { Billing } from "../billing/ledger.js";
import { getLatestBrief, saveBriefVersion } from "../briefs/store.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { orgPolicyOf } from "../runs/queue.js";
import { DbUsageSink } from "../runs/usage.js";
import { insertMessage, type NewMessage } from "../services/messages.js";
import { loadBrief } from "../services/plans.js";
import type { BlobStore } from "../storage/blobs.js";
import { referenceImageColors } from "./images.js";
import { PreviewBuilds, previewHtml } from "./previews.js";

/** payload.type of the chat messages that carry a proposal. */
export const DIRECTIONS_MESSAGE = "design_directions";
/** Requests that may call a model or build previews, per system per window (the rest answer RATE_LIMITED). */
export const DIRECTIONS_RATE = { max: 30, windowMs: 10 * 60_000 } as const;
/** References besides the logo and the owner's words (D77 (7): 1–3). */
export const MAX_REFERENCES = 3;
/** Fixture of the recorded answers in WIZARD_LLM_MODE=fixture (tools/fixtures/unit/<name>.jsonl). */
export const DIRECTIONS_FIXTURE = "design-directions";
const PAGE_CAPTURE_BYTES = 512 * 1024;

export interface DirectionsDeps {
  db: Db;
  blobs: BlobStore;
  config: Config;
  billing: Billing;
  createRouter?: (opts: RouterOptions) => Router;
  /** Pages of URL references (tests: recorded exchanges); default by WIZARD_RESEARCH_MODE (live — guarded network). */
  researchFetch?: ResearchFetch;
  researchMode?: ResearchMode;
  /** Deadline of one model call, ms (tests). */
  deadlineMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** A proposal as stored: the agent's data plus whose and when. */
export interface StoredProposal extends DirectionsProposal {
  systemId: string;
  briefVersion: number;
  nonce: string;
  createdAt: string;
}

export interface DirectionView {
  n: number;
  archetype: string;
  name: string;
  why: string;
  texts: { title: string; lead?: string; action: string };
  textsSource: "model" | "brief";
  /** The owner's wishes applied to this direction, Russian words. */
  tuning: string[];
  header: string;
  hero: string;
  fonts: { display: string; text: string };
  /** Colours of the starting scheme for the card's swatches, hex. */
  palette: { background: string; foreground: string; accent: string };
  /** The live first screen: an HTML document for <iframe srcdoc sandbox="allow-scripts">. */
  previewHtml: string;
}

export interface ProposalView {
  id: string;
  briefVersion: number;
  createdAt: string;
  costRub: number;
  fallback: boolean;
  references: string[];
  /** The direction the brief has pinned (the owner's pick), else null. */
  picked: number | null;
  directions: DirectionView[];
}

export interface SystemRef {
  id: string;
  org_id: string;
  name: string;
}

const isSha = (s: string) => /^[0-9a-f]{64}$/.test(s);

/** fetch that keeps the HTML of the pages it passes (≤ 512 КБ each) for their inline CSS. */
function capturing(inner: ResearchFetch, sink: string[]): ResearchFetch {
  return async (url, init) => {
    const res = await inner(url, init);
    const type = res.headers.get("content-type") ?? "";
    if (/text\/html|xhtml/i.test(type) && res.body) {
      const reader = res.clone().body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
          if (size >= PAGE_CAPTURE_BYTES) {
            await reader.cancel();
            break;
          }
        }
        sink.push(new TextDecoder().decode(Buffer.concat(chunks).subarray(0, PAGE_CAPTURE_BYTES)));
      }
    }
    return res;
  };
}

/** Lines of brief.design.references: the logo, the owner's words and the references proper (links, screenshots). */
function splitReferences(refs: readonly string[]) {
  return {
    logo: refs.filter((r) => r.startsWith(LOGO_HEAD)),
    words: refs.filter((r) => r.startsWith(WORDS_HEAD)),
    others: refs.filter((r) => !r.startsWith(LOGO_HEAD) && !r.startsWith(WORDS_HEAD)),
  };
}

export class DirectionsService {
  readonly previews = new PreviewBuilds();
  #router: Router | undefined;
  readonly #hits = new Map<string, number[]>();

  constructor(readonly d: DirectionsDeps) {}

  /** The platform router of this step (fixture by default; live with WIZARD_LLM_MODE=live), usage into llm_calls. */
  router(): Router {
    if (this.#router) return this.#router;
    const envMode = (process.env.WIZARD_LLM_MODE as LlmMode | undefined) ?? "fixture";
    const mode: LlmMode = envMode === "live" ? "live" : "fixture";
    const opts: RouterOptions = {
      mode,
      registry: createRegistry({ buildDefaultTier: this.d.config.buildDefaultTier }),
      sink: new DbUsageSink(this.d.db),
      ...(mode === "fixture"
        ? {
            fixture: {
              suite: "unit",
              name: DIRECTIONS_FIXTURE,
              lenient: process.env.WIZARD_FIXTURE_LENIENT === "1",
            },
          }
        : {}),
    };
    this.#router = (this.d.createRouter ?? createRouter)(opts);
    return this.#router;
  }

  /** RATE_LIMITED past DIRECTIONS_RATE requests of a system in the window. */
  limit(systemId: string, now = Date.now()): void {
    const recent = (this.#hits.get(systemId) ?? []).filter((t) => now - t < DIRECTIONS_RATE.windowMs);
    if (recent.length >= DIRECTIONS_RATE.max)
      throw new ApiError(
        "RATE_LIMITED",
        "Слишком много запросов к направлениям — попробуйте через несколько минут",
      );
    recent.push(now);
    this.#hits.set(systemId, recent);
  }

  /** The model side for a system: org policy and context; none when the LLM cap of the platform is reached. */
  async #model(sys: SystemRef, wallet?: RubWallet): Promise<DirectionsModel> {
    const base: DirectionsModel = {
      ...(wallet ? { wallet } : {}),
      ...(this.d.deadlineMs ? { deadlineMs: this.d.deadlineMs } : {}),
    };
    try {
      await this.d.billing.assertLlmBudget(sys.org_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "LLM_BUDGET_EXHAUSTED") return base;
      throw e;
    }
    const org = await this.d.db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted"])
      .where("id", "=", sys.org_id)
      .executeTakeFirst();
    const router = this.router();
    return {
      ...base,
      route: (input) => router.route(input),
      orgPolicy: org ? orgPolicyOf(org) : null,
      ctx: { orgId: sys.org_id, systemId: sys.id },
    };
  }

  async #chat(systemId: string, messages: NewMessage[]): Promise<void> {
    await this.d.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("platform.systems")
        .select("id")
        .where("id", "=", systemId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      for (const m of messages) await insertMessage({ trx, events: [] }, m);
    });
  }

  /** A stored proposal by id (null — unknown, not a proposal, or of another system when `systemId` is given). */
  async load(id: string, systemId?: string): Promise<StoredProposal | null> {
    if (!isSha(id)) return null;
    let raw: Buffer;
    try {
      raw = await this.d.blobs.get(id);
    } catch {
      return null;
    }
    let v: unknown;
    try {
      v = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
    if (!isDirectionsProposal(v)) return null;
    const p = v as StoredProposal;
    if (typeof p.systemId !== "string" || (systemId !== undefined && p.systemId !== systemId)) return null;
    return p;
  }

  async #store(
    p: DirectionsProposal,
    systemId: string,
    briefVersion: number,
  ): Promise<{ id: string; stored: StoredProposal }> {
    const stored: StoredProposal = {
      ...p,
      systemId,
      briefVersion,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const { sha256 } = await this.d.blobs.put(
      this.d.db,
      new TextEncoder().encode(JSON.stringify(stored)),
      "application/json",
    );
    return { id: sha256, stored };
  }

  /** The view of a stored proposal: builds (or reuses) the three previews in parallel. */
  async view(id: string, p: StoredProposal, brief: SystemBrief | null): Promise<ProposalView> {
    const built = await Promise.all(p.directions.map((d) => this.previews.build(id, p, d)));
    const pinned = brief?.design.pinned ? brief.design.archetype : undefined;
    return {
      id,
      briefVersion: p.briefVersion,
      createdAt: p.createdAt,
      costRub: p.costRub,
      fallback: p.fallback,
      references: p.references,
      picked: p.directions.find((d) => d.archetype === pinned)?.n ?? null,
      directions: p.directions.map((d, i) => {
        const ds = directionDesign(p, d).design;
        const scheme = ds.palette[ds.palette.scheme];
        return {
          n: d.n,
          archetype: d.archetype,
          name: d.name,
          why: d.why,
          texts: d.texts,
          textsSource: d.textsSource,
          tuning: tuningWords(d.tuning),
          header: d.header,
          hero: d.hero,
          fonts: { display: ds.fonts.display.family, text: ds.fonts.text.family },
          palette: {
            background: cssHex(scheme.bg),
            foreground: cssHex(scheme.ink),
            accent: cssHex(scheme.accent),
          },
          previewHtml: previewHtml(
            id,
            d.n,
            `${d.n}. ${d.name}`,
            built[i] as NonNullable<(typeof built)[number]>,
          ),
        };
      }),
    };
  }

  /** The latest proposal of the system (from its chat), null when there is none or its blob is gone. */
  async latest(sys: SystemRef): Promise<ProposalView | null> {
    const id = await this.#latestId(sys.id);
    const p = id ? await this.load(id, sys.id) : null;
    if (!id || !p) return null;
    const brief = await getLatestBrief(this.d.db, sys.id);
    return this.view(id, p, brief?.brief ?? null);
  }

  /** Three directions from the current brief; `reroll` avoids the archetypes of the latest proposal. */
  async propose(
    sys: SystemRef,
    opts: { reroll?: boolean; signal?: AbortSignal } = {},
  ): Promise<ProposalView> {
    const latest = await getLatestBrief(this.d.db, sys.id);
    if (!latest)
      throw invalid("Сначала нужен бриф системы: ответьте на вопросы интервью, затем выберем оформление");
    let recent: string[] = [];
    if (opts.reroll) {
      const prev = await this.#latestId(sys.id);
      const p = prev ? await this.load(prev, sys.id) : null;
      recent = p ? p.directions.map((d) => d.archetype) : [];
    }
    const niche = directionsNiche(sys.name, await loadBrief(this.d.db, sys.id));
    const model = await this.#model(sys, new RubWallet(DIRECTIONS_BUDGET_RUB, RUB_PER_CREDIT));
    const proposal = await proposeDirections(
      { brief: latest.brief, name: sys.name, niche, seed: sys.id, recent },
      { ...model, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    const { id, stored } = await this.#store(proposal, sys.id, latest.version);
    const view = await this.view(id, stored, latest.brief);
    await this.#chat(sys.id, [
      {
        systemId: sys.id,
        role: "assistant",
        kind: "text",
        text: `Три направления оформления: ${proposal.directions.map((d) => `«${d.name}»`).join(", ")}. Выберите одно или напишите, что поменять.`,
        payload: { type: DIRECTIONS_MESSAGE, proposalId: id, briefVersion: latest.version },
      },
    ]);
    return view;
  }

  async #latestId(systemId: string): Promise<string | null> {
    const row = await this.d.db
      .selectFrom("platform.messages")
      .select(sql<string>`payload->>'proposalId'`.as("proposal_id"))
      .where("system_id", "=", systemId)
      .where("role", "=", "assistant")
      .where(sql<string>`payload->>'type'`, "=", DIRECTIONS_MESSAGE)
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.proposal_id ?? null;
  }

  /** The owner's words: new directions, a pick (saved to the brief) or a polite hint. */
  async refine(
    sys: SystemRef,
    user: { id: string },
    proposalId: string,
    text: string,
  ): Promise<{
    proposal: ProposalView;
    kind: RefineResult["kind"];
    changed: number[];
    reply: string;
    brief?: BriefVersion;
  }> {
    const p = await this.load(proposalId, sys.id);
    if (!p) throw notFound("Направления");
    const model = await this.#model(sys, new RubWallet(DIRECTIONS_BUDGET_RUB, RUB_PER_CREDIT, p.costRub));
    const r = await refineDirections(p, text, model);
    let id = proposalId;
    let stored: StoredProposal = p;
    if (r.kind !== "pick" && JSON.stringify(r.proposal) !== JSON.stringify(p)) {
      ({ id, stored } = await this.#store(r.proposal, sys.id, p.briefVersion));
    }
    let brief: BriefVersion | undefined;
    if (r.kind === "pick" && r.pick)
      brief = (await this.pick(sys, user, proposalId, r.pick, { chat: false })).brief;
    const latest = brief ?? (await getLatestBrief(this.d.db, sys.id)) ?? undefined;
    const view = await this.view(id, stored, latest?.brief ?? null);
    const reply = brief ? `${r.reply} Сохранил в бриф (версия ${brief.version}).` : r.reply;
    await this.#chat(sys.id, [
      { systemId: sys.id, role: "user", kind: "text", text, authorUserId: user.id },
      {
        systemId: sys.id,
        role: "assistant",
        kind: "text",
        text: reply,
        payload: { type: DIRECTIONS_MESSAGE, proposalId: id, briefVersion: stored.briefVersion },
      },
    ]);
    return { proposal: view, kind: r.kind, changed: r.changed, reply, ...(brief ? { brief } : {}) };
  }

  /**
   * The owner's choice as a new brief version: design.archetype, pinned and the owner's words of that direction
   * (references). `n` null — «решите за меня»: the system's first direction, not pinned.
   */
  async pick(
    sys: SystemRef,
    user: { id: string },
    proposalId: string,
    n: number | null,
    o: { chat?: boolean } = {},
  ): Promise<{ brief: BriefVersion; archetype: string; pinned: boolean }> {
    const p = await this.load(proposalId, sys.id);
    if (!p) throw notFound("Направления");
    const latest = await getLatestBrief(this.d.db, sys.id);
    if (!latest) throw invalid("Сначала нужен бриф системы");
    const d = p.directions[(n ?? 1) - 1];
    if (!d) throw invalid("Такого направления нет: выберите 1, 2 или 3");
    const pinned = n !== null;
    const saved = await saveBriefVersion(this.d.db, {
      systemId: sys.id,
      brief: { ...latest.brief, design: pickedDesign(latest.brief.design, p, n) },
      author: "owner",
      authorUserId: user.id,
    });
    if (o.chat !== false)
      await this.#chat(sys.id, [
        {
          systemId: sys.id,
          role: "assistant",
          kind: "text",
          text: pinned
            ? `Выбрано направление «${d.name}» — сохранил в бриф (версия ${saved.version.version}).`
            : `Направление выберет система при сборке; начну с «${d.name}» (бриф, версия ${saved.version.version}).`,
          payload: { type: "design_directions_pick", proposalId, n: pinned ? d.n : null },
        },
      ]);
    return { brief: saved.version, archetype: d.archetype, pinned };
  }

  async #saveReference(
    sys: SystemRef,
    user: { id: string },
    line: string,
    replaceLogo: boolean,
  ): Promise<BriefVersion> {
    const latest = await getLatestBrief(this.d.db, sys.id);
    if (!latest) throw invalid("Сначала нужен бриф системы: референсы сохраняются в нём");
    const { logo, words, others } = splitReferences(latest.brief.design.references);
    if (!replaceLogo && others.length >= MAX_REFERENCES)
      throw invalid(`Референсов уже ${MAX_REFERENCES} — уберите один в брифе, чтобы добавить новый`);
    const references = replaceLogo ? [line, ...others, ...words] : [...logo, ...others, line, ...words];
    const saved = await saveBriefVersion(this.d.db, {
      systemId: sys.id,
      brief: { ...latest.brief, design: { ...latest.brief.design, references } },
      author: "owner",
      authorUserId: user.id,
    });
    return saved.version;
  }

  /** A logo or a screenshot: dominant colours → a principle line in the brief (the file itself is not kept). */
  async addImage(
    sys: SystemRef,
    user: { id: string },
    kind: "logo" | "screenshot",
    bytes: Uint8Array,
  ): Promise<{ reference: string; brief: BriefVersion }> {
    const colors = referenceImageColors(bytes, { allowSvg: kind === "logo" });
    if (!colors.length) throw invalid("На картинке не нашлось цветов: пришлите другую");
    const latest = await getLatestBrief(this.d.db, sys.id);
    const shots = latest ? splitReferences(latest.brief.design.references).others.length : 0;
    const line =
      kind === "logo"
        ? referenceLine(logoPrinciples(colors), "Логотип")
        : referenceLine(screenshotPrinciples(colors), `Скриншот ${shots + 1}`);
    return { reference: line, brief: await this.#saveReference(sys, user, line, kind === "logo") };
  }

  /** A reference link: the page through read_page (no JS) and its inline CSS → a principle line in the brief. */
  async addUrl(
    sys: SystemRef,
    user: { id: string },
    raw: string,
  ): Promise<{ reference: string; brief: BriefVersion; read: boolean }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw invalid("Ссылка должна начинаться с https:// или http://");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw invalid("Ссылка должна начинаться с https:// или http://");
    const host = url.hostname.replace(/^www\./, "");
    const mode = this.d.researchMode ?? researchMode(process.env);
    const inner = this.d.researchFetch ?? (mode === "live" ? guardedTransport(systemResolver) : undefined);
    const pages: string[] = [];
    const research = createResearch({
      mode,
      ...(inner ? { fetch: capturing(inner, pages) } : {}),
      limits: { searches: 0, pages: 3, discover: 0 },
      context: { orgId: sys.org_id, systemId: sys.id },
    });
    let line: string;
    let read = true;
    try {
      const page = await research.readPage(url.href);
      line = referenceLine(pagePrinciples(pages.at(-1) ?? null, page.markdown), `Сайт ${host}`);
    } catch (e) {
      if (
        e instanceof ResearchError &&
        ["URL_INVALID", "SCHEME_FORBIDDEN", "EGRESS_PRIVATE"].includes(e.code)
      )
        throw invalid(`Эту ссылку открыть нельзя: ${e.message}`);
      read = false;
      line = `Сайт ${host}: страницу прочитать не удалось — оформление подберёт система по брифу.`;
      this.d.log?.("direction reference read failed", e instanceof ResearchError ? e.code : e);
    }
    return { reference: line, brief: await this.#saveReference(sys, user, line, false), read };
  }
}
