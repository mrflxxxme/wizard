// Documentation → contract (V3-20; D77 (15)): discover_docs of the service's domain (llms.txt, openapi.json,
// swagger.json, api-catalog — research V3-05, D46 network rules) gives an OpenAPI document → contract by code; a link
// straight to a JSON description is read as is; without a machine description the page is read (read_page) and, when
// the host gives a model route, mapped by one research call (prose.ts). Field mapping by code on top.

import type { RouteFn, RunStepFn } from "../core/index.js";
import type { Research } from "../research/research.js";
import type { IntegrationContract } from "./contract.js";
import { type MappingEntity, mapFields } from "./mapping.js";
import { contractFromOpenApi, OpenApiImportError } from "./openapi.js";
import { contractFromProse } from "./prose.js";

export interface DocsContractInput {
  research: Research;
  /** Brief integration. */
  id: string;
  name: string;
  /** Documentation link or the service's domain. */
  url: string;
  need?: string;
  /** Data of the system to map (brief data or spec entities). */
  data?: readonly MappingEntity[];
  /** Model route for prose documentation; absent — prose gives no contract. */
  route?: RouteFn;
  runStep?: RunStepFn;
  signal?: AbortSignal;
  secret?: string;
}

export interface DocsContractResult {
  contract: IntegrationContract | null;
  /** openapi — by code from a machine description; prose — by the model from a page. */
  method: "openapi" | "prose" | null;
  /** Why there is no contract (Russian). */
  reason_ru: string | null;
}

const withMapping = (
  c: IntegrationContract,
  data: readonly MappingEntity[] | undefined,
): IntegrationContract =>
  data?.length && c.mapping.length === 0 ? { ...c, mapping: mapFields(c, data) } : c;

/** Finds the API description behind a documentation link and turns it into a contract. */
export async function contractFromDocs(o: DocsContractInput): Promise<DocsContractResult> {
  const base = {
    id: o.id,
    name: o.name,
    ...(o.need ? { need: o.need } : {}),
    ...(o.secret ? { secret: o.secret } : {}),
  };
  const fromText = (text: string, url: string): DocsContractResult => {
    try {
      return {
        contract: withMapping(contractFromOpenApi(text, { ...base, url }), o.data),
        method: "openapi",
        reason_ru: null,
      };
    } catch (e) {
      return {
        contract: null,
        method: null,
        reason_ru: e instanceof OpenApiImportError ? e.message_ru : "Описание API не прочиталось",
      };
    }
  };
  const entry = await o.research.discover(o.url);
  if (entry.openapi) {
    const raw = await o.research.docs.raw(entry.openapi.url);
    if (raw) return fromText(raw, entry.openapi.url);
  }
  const page = await o.research.readPage(o.url);
  const trimmed = page.markdown.trim();
  if (trimmed.startsWith("{")) {
    const r = fromText(trimmed, page.url);
    if (r.contract) return r;
  }
  if (!o.route)
    return {
      contract: null,
      method: null,
      reason_ru:
        "На сайте не нашлось машинного описания API (openapi.json) — пришлите файл OpenAPI или ссылку на него",
    };
  const r = await contractFromProse({
    ...base,
    need: o.need ?? o.name,
    markdown: page.markdown,
    url: page.url,
    ...(o.data ? { data: o.data } : {}),
    route: o.route,
    ...(o.runStep ? { runStep: o.runStep } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  return r.contract
    ? { contract: withMapping(r.contract, o.data), method: "prose", reason_ru: null }
    : { contract: null, method: null, reason_ru: r.reason_ru };
}
