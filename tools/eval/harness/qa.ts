// QA and G1 inputs of the eval harness: the real QA agent (@wizard/agents/qa, M0-14) over the run's router, and the
// compliance fields the owner/platform fill before G1 (M0-14 notes: without consentText every pii write is 422).

import type { BuilderQa } from "../../../packages/agents/src/builder/index.ts";
import { createQaAgent } from "../../../packages/agents/src/qa/index.ts";
import type { AppSpec } from "../../../packages/appspec/src/index.ts";
import { OWNER_ONLY_COMPLIANCE_FIELDS } from "../../../packages/appspec/src/index.ts";
import type { OrgPolicy, RouteInput, RouteOutput } from "../../../packages/llm/src/index.ts";

type Route = (input: RouteInput) => Promise<RouteOutput>;

/** Synthetic owner compliance for eval systems (no real operator). */
export const EVAL_OWNER_COMPLIANCE = {
  consentText:
    "Я соглашаюсь на обработку моих персональных данных для работы с системой. Данные удаляются по окончании срока хранения.",
  operatorName: "ООО «Тестовый оператор»",
  operatorContact: "privacy@operator.example",
} as const;

/** The spec as G1 sees it after the owner/platform filled their compliance fields (existing values are kept). */
export function withOwnerCompliance(spec: AppSpec): AppSpec {
  const c = (spec.compliance ?? {}) as Record<string, unknown>;
  const fill: Record<string, unknown> = {};
  for (const k of OWNER_ONLY_COMPLIANCE_FIELDS)
    if (c[k] === undefined && k in EVAL_OWNER_COMPLIANCE)
      fill[k] = EVAL_OWNER_COMPLIANCE[k as keyof typeof EVAL_OWNER_COMPLIANCE];
  return { ...spec, compliance: { ...c, ...fill } as AppSpec["compliance"] };
}

/** QA agent (qa_generate/qa_explain through the same router: usage and T1 payloads are counted). */
export function evalQa(route: Route, o: { orgPolicy: OrgPolicy; ctx: RouteInput["ctx"] }): BuilderQa {
  const qa = createQaAgent({
    route,
    orgPolicy: o.orgPolicy,
    ...(o.ctx ? { ctx: o.ctx } : {}),
    milestone: "M0",
  });
  return { generate: (input) => qa.generate(input), explain: (input) => qa.explain(input) };
}
