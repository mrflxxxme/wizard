// BYOK policy (V3-33; product.yaml#decisions.D77_v3 (14), (14б); security/data-boundary.yaml#byok): which calls may go
// to a user's own key, the provider list (data: providers.json), the base URL rules (direct only for providers that
// accept requests from RF, the user's gateway otherwise, never an own geo-block workaround) and the key format.
// The gateway allowlist of V3-16 (allowlist.ts) keeps guarding the PLATFORM keys only.
import { LlmError } from "../errors.js";
import {
  containsTokens,
  type DecideInput,
  decideTier,
  hasAttachments,
  type PolicyDecision,
} from "../policy.js";
import type { Registry } from "../registry.js";
import type { CallType, LlmMessage } from "../types.js";
import catalog from "./providers.json" with { type: "json" };

/** Request-body rules of a provider (providers.ts transformBody); openai — the generic ones. */
export type ByokBody = "openai" | "zai" | "deepseek" | "cloudru";

export interface ByokProviderDef {
  id: string;
  /** Shown to the user as is (brand names; the gateway entry is in Russian). */
  name: string;
  location: "ru" | "foreign";
  /** true → called directly at baseUrl; false → only through the user's OpenAI-compatible gateway. */
  acceptsRu: boolean;
  baseUrl?: string;
  /** API hosts of the provider: never a gateway address (that would be a direct call from RF). */
  officialHosts: string[];
  body: ByokBody;
  /** Models we have checked in the pipeline; any other is «не проверена нами». */
  verifiedModels: string[];
  suggestedModels: string[];
  termsNote?: string;
}

export interface ByokCatalog {
  version: number;
  checkedAt: string;
  providers: ByokProviderDef[];
}

const BODIES: ReadonlySet<string> = new Set(["openai", "zai", "deepseek", "cloudru"]);
const PROVIDER_ID = /^[a-z][a-z0-9_]{1,31}$/;

/** Throws on a malformed catalog (the data file or a test's own list). */
export function validateByokCatalog(c: ByokCatalog): ByokCatalog {
  const seen = new Set<string>();
  for (const p of c.providers) {
    if (!PROVIDER_ID.test(p.id) || seen.has(p.id))
      throw new Error(`byok catalog: bad or duplicate id ${p.id}`);
    seen.add(p.id);
    if (!BODIES.has(p.body)) throw new Error(`byok catalog: ${p.id} has unknown body ${p.body}`);
    if (p.acceptsRu && !p.baseUrl) throw new Error(`byok catalog: ${p.id} accepts RF but has no baseUrl`);
    if (!p.acceptsRu && p.baseUrl)
      throw new Error(`byok catalog: ${p.id} blocks RF, it has no direct baseUrl`);
    if (p.location !== "ru" && p.location !== "foreign") throw new Error(`byok catalog: ${p.id} location`);
  }
  return c;
}

/** The provider list of providers.json (data, not code). */
export const BYOK_CATALOG: ByokCatalog = validateByokCatalog(catalog as ByokCatalog);

export function findByokProvider(id: string, c: ByokCatalog = BYOK_CATALOG): ByokProviderDef | null {
  return c.providers.find((p) => p.id === id) ?? null;
}

/** false → the UI marks the model «не проверена нами» (D77 (14б)); gates and techreview run as usual. */
export function byokModelVerified(provider: ByokProviderDef, model: string): boolean {
  return provider.verifiedModels.includes(model);
}

/**
 * Call types a user's key may serve: the authoring calls of a build whose data-boundary tier allows T1 after scrub.
 * Never: T0-only calls (brief_extract, research, runtime_ai_*, support), import_mapping (real values) and the
 * checks — techreview, audit, qa_*, critic_visual (screenshots cannot be masked until packages/pii/image, M2-97):
 * gates and review stay on the platform's models whatever the user's model is.
 */
export const BYOK_CALL_TYPES: readonly CallType[] = [
  "interview",
  "interview_v3",
  "card",
  "plan",
  "system_plan",
  "art_direction",
  "build_texts",
  "build_design",
  "build_custom",
  "build_ops",
  "build_code",
  "fix",
  "page_compose",
  "signature_section",
];

export function isByokCallType(callType: string): callType is CallType {
  return (BYOK_CALL_TYPES as readonly string[]).includes(callType);
}

export type ByokRefusal = "call_type" | "attachments" | "tokens" | PolicyDecision["reason"];

export type ByokDecision =
  | { ok: true; decision: PolicyDecision; messages: LlmMessage[] }
  | { ok: false; reason: ByokRefusal };

/**
 * May this call go to the org's own key? The T1 rules of the platform policy apply in full, whatever the build tier
 * switch (week0) says: ruOnly, the region restriction, PII hints, strong or special PII and the raw interview input
 * keep the call on the platform's RF models; basic PII is replaced by placeholders before anything leaves (scrub is
 * applied to every BYOK call, the provider's location notwithstanding — the model a user picks is out of our sight).
 */
export function byokDecision(input: DecideInput, reg: Registry): ByokDecision {
  if (!isByokCallType(input.callType)) return { ok: false, reason: "call_type" };
  if (hasAttachments(input.messages)) return { ok: false, reason: "attachments" };
  const route = reg.routes[input.callType];
  const asT1: Registry = {
    ...reg,
    buildDefaultTier: "T1",
    routes: { ...reg.routes, [input.callType]: { ...route, defaultTier: "T1" } },
  };
  const decision = decideTier(input, asT1);
  if (decision.tier !== "T1") return { ok: false, reason: decision.reason };
  if (containsTokens(decision.scrubbedMessages)) return { ok: false, reason: "tokens" };
  return { ok: true, decision, messages: decision.scrubbedMessages };
}

// ---------------------------------------------------------------- base URL policy

export type ByokUrlViolation =
  | "gateway_required"
  | "gateway_not_allowed"
  | "bad_url"
  | "insecure_url"
  | "credentials_in_url"
  | "official_host"
  | "private_host";

export interface ByokUrlOptions {
  /** Tests and local stands only: loopback and private hosts, plain http. Never in production. */
  allowPrivateNetwork?: boolean;
  catalog?: ByokCatalog;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6, mapped v4 included). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const mapped = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  // The URL parser writes a mapped v4 address in hex: [::ffff:127.0.0.1] → [::ffff:7f00:1].
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && Number(v4[3]) === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!v.includes(":")) return false;
  if (v === "::" || v === "::1") return true;
  const head = Number.parseInt(v.split(":")[0] || "0", 16);
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xff00) === 0xff00;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

/** null → the host may be called; the DNS answer is checked again at connect time (byok/net.ts). */
export function hostViolation(host: string, o: ByokUrlOptions = {}): ByokUrlViolation | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (o.allowPrivateNetwork) return null;
  if (isIpLiteral(h)) return isPrivateAddress(h) ? "private_host" : null;
  if (!h.includes(".") || h === "localhost" || BLOCKED_SUFFIXES.some((s) => h.endsWith(s)))
    return "private_host";
  return null;
}

/**
 * The address a BYOK call goes to: the provider's own baseUrl when it accepts requests from RF (no gateway then), the
 * user's gateway otherwise — https, no credentials or query, not a host of a provider that blocks RF, not a private
 * network. Returns the normalized URL or the violation.
 */
export function byokBaseUrl(
  provider: ByokProviderDef,
  gatewayUrl: string | null | undefined,
  o: ByokUrlOptions = {},
): { url: string } | { violation: ByokUrlViolation } {
  const gw = gatewayUrl?.trim() || null;
  if (provider.acceptsRu) {
    if (gw) return { violation: "gateway_not_allowed" };
    return { url: (provider.baseUrl as string).replace(/\/+$/, "") };
  }
  if (!gw) return { violation: "gateway_required" };
  let u: URL;
  try {
    u = new URL(gw);
  } catch {
    return { violation: "bad_url" };
  }
  if (u.protocol !== "https:" && !(o.allowPrivateNetwork && u.protocol === "http:"))
    return { violation: u.protocol === "http:" ? "insecure_url" : "bad_url" };
  if (u.username || u.password) return { violation: "credentials_in_url" };
  if (u.search || u.hash || gw.includes("?") || gw.includes("#")) return { violation: "bad_url" };
  const host = u.hostname.toLowerCase();
  const official = (o.catalog ?? BYOK_CATALOG).providers
    .filter((p) => !p.acceptsRu)
    .flatMap((p) => p.officialHosts);
  if (official.some((h) => host === h || host.endsWith(`.${h}`))) return { violation: "official_host" };
  const hv = hostViolation(u.hostname, o);
  if (hv) return { violation: hv };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

// ---------------------------------------------------------------- key and model format

/** A key: printable ASCII without spaces, 8…512 characters. Validation never echoes the value. */
export const BYOK_KEY_RE = /^[\x21-\x7e]{8,512}$/;
/** A model name as the provider or gateway expects it (OpenRouter «vendor/model», Yandex «gpt://folder/model»). */
export const BYOK_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** The last 4 characters shown in the UI («•••• abcd»). */
export function byokLast4(key: string): string {
  return key.slice(-4);
}

/** Throws a value-free LlmError when the key or the model name is malformed. */
export function assertByokInput(key: string, model: string): void {
  if (!BYOK_KEY_RE.test(key))
    throw new LlmError("BYOK_INVALID", "Ключ должен состоять из 8–512 печатных символов без пробелов.");
  if (!BYOK_MODEL_RE.test(model)) throw new LlmError("BYOK_INVALID", "Название модели указано с ошибкой.");
}
