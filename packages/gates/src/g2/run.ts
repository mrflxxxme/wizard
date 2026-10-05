// G2 orchestration (specs/quality/gates.yaml#G2): static checks over spec + sources (secrets, ПДн, Telegram,
// antifraud, public role) and the permission matrix against the runtime; time budget 300 s.
import {
  CHECK_BY_ID,
  type CheckDef,
  compareMilestones,
  G2_CHECKS,
  G2_TIME_BUDGET_MS,
  resolveMilestone,
} from "../catalog.js";
import { type CheckOutcome, type Finding, isPassed, summarize, toChecks } from "../report.js";
import type { Check, GateContext, GateReport } from "../types.js";
import {
  type AfContext,
  brands,
  cardCollection,
  credentials,
  cryptoCodes,
  externalPost,
  govIds,
  oriSignal,
  p2pPayment,
  riskScore,
} from "./antifraud.js";
import { DYNAMIC_CHECKS, type DynamicOptions, runDynamic } from "./dynamic.js";
import { egressHosts, egressNewHosts } from "./egress.js";
import { ABUSE } from "./patterns.js";
import { consentForms, forbiddenCategories, markup, operator, retention, specialHints } from "./pii.js";
import { publicRole, secretRefs, secretsInCode, telegramNoPii } from "./static.js";
import { buildCorpus } from "./texts.js";

export interface G2Options {
  /** Run only these check ids (fixtures); the others are left out of the report. */
  only?: readonly string[];
  timeBudgetMs?: number;
  dynamic?: DynamicOptions;
}

const def = (id: string): CheckDef => CHECK_BY_ID.get(id) as CheckDef;
const findings = (f: Finding[]): CheckOutcome => ({ kind: "findings", findings: f });

export async function runG2(ctx: GateContext, opts: G2Options = {}): Promise<GateReport> {
  const started = Date.now();
  const startedAt = (ctx.now ?? new Date(started)).toISOString();
  const deadline = started + (opts.timeBudgetMs ?? G2_TIME_BUDGET_MS);
  const timeLeft = () => Date.now() < deadline && !ctx.signal?.aborted;
  const milestone = resolveMilestone(ctx.milestone);
  const afterM2 = compareMilestones(milestone, "M2") >= 0;
  const want = (id: string) => !opts.only || opts.only.includes(id);
  const spec = ctx.spec;
  const files = new Map([...ctx.files].filter(([p]) => /^(ui|functions)\//.test(p)));
  const outcomes = new Map<string, CheckOutcome>();
  const set = (id: string, run: () => CheckOutcome) => {
    if (!want(id)) return;
    if (!timeLeft()) {
      outcomes.set(id, { kind: "error", reason_ru: "превышено время G2 (300 с)" });
      return;
    }
    try {
      outcomes.set(id, run());
    } catch (e) {
      outcomes.set(id, {
        kind: "error",
        reason_ru: "внутренняя ошибка проверки",
        evidence: String((e as Error)?.message ?? e),
      });
    }
  };

  const corpus = buildCorpus(spec, files, ctx.slug);
  const af: AfContext = { spec, corpus, files, milestone, ctx, afterM2 };

  set("G2-SECRET-01", () => findings(secretsInCode(spec, files)));
  if (want("G2-SECRET-02")) {
    try {
      const r = await secretRefs(spec, ctx.env, ctx.secretExists);
      outcomes.set("G2-SECRET-02", r.error ? { kind: "error", reason_ru: r.error } : findings(r.findings));
    } catch (e) {
      outcomes.set("G2-SECRET-02", {
        kind: "error",
        reason_ru: "хранилище секретов недоступно",
        evidence: String((e as Error)?.message ?? e),
      });
    }
  }
  set("G2-PII-01", () => findings(forbiddenCategories(spec)));
  set("G2-PII-02", () => findings(markup(spec)));
  set("G2-PII-03", () => findings(specialHints(spec)));
  set("G2-PII-04", () => findings(consentForms(spec, corpus.sources, files)));
  set("G2-PII-05", () => findings(retention(spec)));
  set("G2-PII-06", () => findings(operator(spec, afterM2)));
  set("G2-TG-01", () => findings(telegramNoPii(spec, corpus.sources)));
  set("G2-PERM-05", () => findings(publicRole(spec, corpus.sources, files)));
  set("G2-EGRESS-01", () => findings(egressHosts(spec)));
  set("G2-EGRESS-02", () => findings(egressNewHosts(spec, ctx.prevSpec, ctx.env)));
  set("G2-AF-01", () => findings(cardCollection(af)));
  set("G2-AF-02", () => findings(credentials(af)));
  set("G2-AF-03", () => findings(govIds(af)));
  const brandScan = brands(af);
  set("G2-AF-04", () => findings(brandScan.findings));
  set("G2-AF-05", () => findings(externalPost(af)));
  set("G2-AF-06", () => findings(p2pPayment(af)));
  set("G2-AF-07", () => findings(cryptoCodes(af)));
  set("G2-AF-08", () => {
    const r = riskScore(af, brandScan);
    if (r.score < ABUSE.scoring.threshold) return findings([]);
    return findings([
      {
        message_ru: ABUSE.messages.review ?? "Перед публикацией систему посмотрит модератор",
        evidence: `risk_score=${r.score} ≥ ${ABUSE.scoring.threshold}: ${r.signals.join(", ")}; founder_review`,
      },
    ]);
  });
  set("G2-AF-09", () => findings(oriSignal(spec)));

  const dynamicWanted = DYNAMIC_CHECKS.filter(want);
  if (dynamicWanted.length) {
    const r = timeLeft() ? await runDynamic(ctx, opts.dynamic ?? {}, timeLeft) : null;
    for (const id of dynamicWanted)
      outcomes.set(id, r ? r[id] : { kind: "error", reason_ru: "превышено время G2 (300 с)" });
  }

  const checks: Check[] = [];
  for (const d of G2_CHECKS) {
    const o = outcomes.get(d.id);
    if (o) checks.push(...toChecks(def(d.id), o));
  }
  return {
    level: "G2",
    passed: isPassed(checks),
    specVersion: ctx.specVersion,
    startedAt,
    durationMs: Date.now() - started,
    checks,
    summary: summarize(checks),
  };
}
