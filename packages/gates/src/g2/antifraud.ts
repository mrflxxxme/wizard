// G2-AF-01…09 (specs/quality/gates.yaml#G2 antifraud, specs/security/abuse.yaml#patterns, #scoring).
// Findings carry the neutral abuse.yaml#messages_ru text; the rule and location go to evidence (no ПДн values).
import { type AppSpec, USERS_ENTITY } from "@wizard/appspec";
import ts from "typescript";
import { importGraph, reachable } from "../g0/imports.js";
import { nodeLine, unwrap } from "../g0/source.js";
import type { Finding } from "../report.js";
import type { GateContext } from "../types.js";
import {
  ABUSE,
  type BrandHit,
  findBrands,
  firstMatch,
  luhn,
  near,
  normalize,
  rx,
  skeleton,
} from "./patterns.js";
import type { Corpus, TextItem } from "./texts.js";

/** Extensions of abuse.yaml patterns (allowed: «расширять можно»), see docs/reviews/impl-notes/M2-04.md. */
const EXTRA_CARD = "(номер|№)\\s*(банковской|кредитной|дебетовой)\\s+карты";

const RE = {
  card: rx(`${ABUSE.card.names}|${EXTRA_CARD}`, "giu"),
  cred: rx(ABUSE.credentials.names, "giu"),
  gov: rx(ABUSE.govIds.names, "giu"),
  fileDocs: rx(ABUSE.govIds.fileDocs, "giu"),
  crypto: rx(ABUSE.crypto.names, "giu"),
  formsCtx: rx(ABUSE.brands.formsContext, "giu"),
  ambCtx: rx(ABUSE.brands.ambiguousContext, "giu"),
  p2pWords: rx(ABUSE.p2p.words, "giu"),
  urgent: rx(ABUSE.scoring.urgentWords, "giu"),
  sbp: rx("сбп|по номеру телефона", "giu"),
};

const CARD_NO = /(?<!\d)\d(?:[ -]?\d){11,18}(?!\d)/g;
const ACCOUNT = /(?<!\d)\d{5}[ ]?\d{3}[ ]?\d[ ]?\d{4}[ ]?\d{7}(?!\d)|(?<!\d)\d{20}(?!\d)/g;
const PHONE = /(?<![\d+])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g;
const WALLET = /(?<![\p{L}\p{N}])(?:bc1[a-z0-9]{25,60}|0x[0-9a-f]{40}|t[1-9a-z]{33})(?![\p{L}\p{N}])/gu;

export interface AfContext {
  spec: AppSpec;
  corpus: Corpus;
  files: ReadonlyMap<string, string>;
  milestone: string;
  ctx: Pick<GateContext, "abuse">;
  afterM2: boolean;
}

const msg = (id: string) => ABUSE.messages[id] ?? "Публикация приостановлена до проверки модератором";
const mask = (s: string) => s.replace(/\d/g, "•");

function at(item: TextItem): Pick<Finding, "file" | "line" | "path"> {
  return {
    ...(item.file ? { file: item.file } : {}),
    ...(item.line ? { line: item.line } : {}),
    ...(item.path ? { path: item.path } : {}),
  };
}

function fromItem(id: string, item: TextItem, rule: string, hit?: string): Finding {
  return {
    message_ru: msg(id),
    ...at(item),
    evidence: `${rule}; ${item.zone}/${item.kind}: «${mask(item.raw).slice(0, 120)}»${hit ? ` → «${mask(hit)}»` : ""}`,
  };
}

const isInput = (i: TextItem) => i.input !== undefined || i.zone === "forms";

/** G2-AF-01: card data collection outside ЮKassa. */
export function cardCollection(c: AfContext): Finding[] {
  const out: Finding[] = [];
  for (const i of c.corpus.items) {
    if (!isInput(i)) continue;
    const m = firstMatch(RE.card, i.norm);
    if (m) out.push(fromItem("G2-AF-01", i, "card_collection.names", m.text));
  }
  for (const s of c.corpus.signals) {
    const auto = s.kind === "autocomplete" && ABUSE.card.autocomplete.includes(s.value ?? "");
    if (auto || s.kind === "luhn" || s.kind === "card_mask")
      out.push({
        message_ru: msg("G2-AF-01"),
        file: s.file,
        line: s.line,
        evidence: `card_collection: ${s.detail}`,
      });
  }
  return out;
}

/** G2-AF-02: passwords, PIN/OTP and confirmation codes. */
export function credentials(c: AfContext): Finding[] {
  const out: Finding[] = [];
  for (const i of c.corpus.items) {
    if (!isInput(i)) continue;
    const m = firstMatch(RE.cred, i.norm);
    if (m) out.push(fromItem("G2-AF-02", i, "credentials.names", m.text));
  }
  for (const s of c.corpus.signals) {
    if (s.kind === "password_input")
      out.push({
        message_ru: msg("G2-AF-02"),
        file: s.file,
        line: s.line,
        evidence: `credentials: ${s.detail}`,
      });
  }
  return out;
}

/** G2-AF-03: passport, СНИЛС, ИНН физлица, driving licence; since M2 also document scans in file fields. */
export function govIds(c: AfContext): Finding[] {
  const out: Finding[] = [];
  for (const i of c.corpus.items) {
    if (!isInput(i)) continue;
    const m = firstMatch(RE.gov, i.norm);
    if (m) {
      out.push(fromItem("G2-AF-03", i, "gov_ids.names", m.text));
      continue;
    }
    if (c.afterM2 && i.input?.type === "file") {
      const f = firstMatch(RE.fileDocs, i.norm);
      if (f) out.push(fromItem("G2-AF-03", i, "gov_ids.file_fields", f.text));
    }
  }
  for (const [ei, e] of c.spec.entities.entries()) {
    for (const [fi, f] of e.fields.entries()) {
      if (f.piiKind === "passport" || f.piiKind === "snils" || f.piiKind === "inn")
        out.push({
          message_ru: msg("G2-AF-03"),
          path: `/entities/${ei}/fields/${fi}/piiKind`,
          evidence: `gov_ids: piiKind=${f.piiKind} у поля ${e.name}.${f.name}`,
        });
    }
  }
  return out;
}

/** Skeletons of brand names a connected integration / login method outputs (abuse.yaml#brands.connector_allowlist). */
export function connectorAllowlist(spec: AppSpec): Set<string> {
  const keys = new Set<string>();
  for (const i of spec.integrations ?? []) keys.add(`integration:${i.connector}`);
  for (const r of spec.roles) for (const m of r.loginMethods ?? []) keys.add(`login:${m}`);
  const out = new Set<string>();
  for (const k of keys) for (const n of ABUSE.brands.connectorAllowlist[k] ?? []) out.add(brandKey(n));
  return out;
}

const brandKey = (name: string) => skeleton(normalize(name)).replace(/[^\p{L}\p{N}]+/gu, "");

export interface BrandScan {
  findings: Finding[];
  fuzzy: number;
  inText: number;
}

/** G2-AF-04: brand imitation in identity (exact/≤1) and forms (≥5 chars near payment/login words). */
export function brands(c: AfContext): BrandScan {
  const allow = connectorAllowlist(c.spec);
  const org = new Set((c.ctx.abuse?.brandAllowlist ?? []).map((x) => x.toLowerCase()));
  const res: BrandScan = { findings: [], fuzzy: 0, inText: 0 };
  const orgAllowed = (h: BrandHit) =>
    org.has(h.brand.id) || h.brand.names.some((n) => org.has(n.toLowerCase()));
  for (const i of c.corpus.items) {
    for (const h of findBrands(i.norm, { translit: i.kind === "slug" })) {
      if (orgAllowed(h)) continue;
      if (h.ambiguous && !near(RE.ambCtx, i.norm, h.start, h.end, ABUSE.brands.ambiguousWindow)) continue;
      const connector = allow.has(brandKey(h.name));
      const hit = i.norm.slice(h.start, h.end);
      if (i.zone === "identity") {
        // Page titles show connector names legitimately («Оплата через ЮKassa»); app name, slug, logo, operator never.
        if (connector && i.kind === "page.title") continue;
        if (h.distance <= 1)
          res.findings.push(fromItem("G2-AF-04", i, `brands.identity ${h.brand.id} (d=${h.distance})`, hit));
        else res.fuzzy++;
        continue;
      }
      if (connector || h.distance > 1) continue;
      if (
        i.zone === "forms" &&
        !h.short &&
        near(RE.formsCtx, i.norm, h.start, h.end, ABUSE.brands.formsWindow)
      ) {
        res.findings.push(fromItem("G2-AF-04", i, `brands.forms ${h.brand.id} (d=${h.distance})`, hit));
        continue;
      }
      res.inText++;
    }
  }
  return res;
}

/** G2-AF-05: form data posted / linked to external hosts; function egress outside function.egress. */
export function externalPost(c: AfContext): Finding[] {
  const out: Finding[] = [];
  for (const s of c.corpus.signals) {
    if (s.kind === "external_post" || s.kind === "external_frame")
      out.push({
        message_ru: msg("G2-AF-05"),
        file: s.file,
        line: s.line,
        evidence: `external_post: ${s.detail}`,
      });
  }
  // ctx.http.fetch(<absolute URL>) in a file reachable from a function whose egress lacks the host.
  const fnSources = c.corpus.sources.filter((s) => s.area === "functions");
  const graph = importGraph(fnSources, c.files);
  const reach = new Map<string, Set<string>>();
  for (const f of c.spec.functions ?? []) reach.set(f.name, reachable([f.file], graph));
  for (const src of fnSources) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && /\.http\.fetch$/.test(unwrap(n.expression).getText())) {
        const a = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
        const text =
          a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
            ? a.text
            : a && ts.isTemplateExpression(a)
              ? a.head.text
              : "";
        const host = /^https?:\/\/([^/?#:]+)/i.exec(text)?.[1]?.toLowerCase();
        for (const f of c.spec.functions ?? []) {
          if (!reach.get(f.name)?.has(src.path)) continue;
          const egress = f.egress ?? [];
          if (host ? !egress.includes(host) : egress.length === 0)
            out.push({
              message_ru: msg("G2-AF-05"),
              file: src.path,
              line: nodeLine(n),
              evidence: `egress: функция ${f.name} обращается к ${host ?? "внешнему адресу"} вне function.egress`,
            });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
  }
  return out;
}

/** G2-AF-06: card / account / SBP phone / wallet near transfer words in any text. */
export function p2pPayment(c: AfContext): Finding[] {
  const out: Finding[] = [];
  const win = ABUSE.p2p.window;
  for (const i of c.corpus.items) {
    const t = i.norm;
    const found = (re: RegExp, ok: (m: string) => boolean, extra?: RegExp): string | null => {
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        if (!ok(m[0])) continue;
        const s = m.index;
        const e = s + m[0].length;
        if (!near(RE.p2pWords, t, s, e, win)) continue;
        if (extra && !near(extra, t, s, e, win)) continue;
        return m[0];
      }
      return null;
    };
    const card = found(CARD_NO, (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhn(d);
    });
    const acct = card ? null : found(ACCOUNT, () => true);
    const phone = card || acct ? null : found(PHONE, () => true, RE.sbp);
    const wallet = card || acct || phone ? null : found(WALLET, () => true);
    const hit = card ?? acct ?? phone ?? wallet;
    if (hit) out.push(fromItem("G2-AF-06", i, "p2p_payment", hit));
  }
  return out;
}

/** G2-AF-07: seed phrases, private keys, wallet-draining code. */
export function cryptoCodes(c: AfContext): Finding[] {
  const out: Finding[] = [];
  for (const i of c.corpus.items) {
    if (!isInput(i)) continue;
    const m = firstMatch(RE.crypto, i.norm);
    if (m) out.push(fromItem("G2-AF-07", i, "crypto_codes.names", m.text));
  }
  const strong = new Set(
    c.corpus.signals.filter((s) => s.kind === "crypto" || s.kind === "hex_address").map((s) => s.file),
  );
  for (const s of c.corpus.signals) {
    if (s.kind === "crypto" || (s.kind === "crypto_weak" && strong.has(s.file)))
      out.push({
        message_ru: msg("G2-AF-07"),
        file: s.file,
        line: s.line,
        evidence: `crypto_codes: ${s.detail}`,
      });
  }
  return out;
}

/** G2-AF-08: risk score (abuse.yaml#scoring); ≥ threshold → warning (founder_review, draft not blocked). */
export function riskScore(c: AfContext, b: BrandScan): { score: number; signals: string[] } {
  const w = ABUSE.scoring.signals;
  const on: string[] = [];
  const a = c.ctx.abuse ?? {};
  if (a.orgAgeDays !== undefined && a.orgAgeDays < 7) on.push("new_org_lt_7d");
  if (a.plan === "free") on.push("free_plan");
  if (b.fuzzy > 0) on.push("brand_fuzzy_match_distance_2");
  if (b.inText > 0) on.push("brand_in_text");
  if (obfuscated(c)) on.push("obfuscated_strings");
  if (c.corpus.externalHosts.size > 5) on.push("external_links_gt_5");
  if (publicPhoneAndEmail(c.spec)) on.push("collects_phone_and_email_public");
  if (c.corpus.items.some((i) => firstMatch(RE.urgent, i.norm))) on.push("urgent_words");
  if ((a.abuseReportsPrev ?? 0) > 0) on.push("abuse_reports_prev");
  return { score: on.reduce((s, k) => s + (w[k] ?? 0), 0), signals: on };
}

function obfuscated(c: AfContext): boolean {
  for (const src of c.corpus.sources) {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const t = n.text;
        if (t.length > 200 && (/^[A-Za-z0-9+/=_-]+$/.test(t) || /^(?:\\x[0-9a-f]{2}|[0-9a-f])+$/i.test(t)))
          hit = true;
      }
      if (ts.isCallExpression(n) && /fromCharCode$/.test(n.expression.getText()) && n.arguments.length > 20)
        hit = true;
      ts.forEachChild(n, visit);
    };
    visit(src.sf);
    if (hit) return true;
  }
  return false;
}

function publicPhoneAndEmail(spec: AppSpec): boolean {
  const pub = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  return spec.permissions.some((p) => {
    if (!pub.has(p.role) || !p.ops.includes("create")) return false;
    const e = spec.entities.find((x) => x.name === p.entity);
    return !!e && e.fields.some((f) => f.type === "phone") && e.fields.some((f) => f.type === "email");
  });
}

/** G2-AF-09: user-to-user text (ОРИ signal) → warning and founder_review. */
export function oriSignal(spec: AppSpec): Finding[] {
  const out: Finding[] = [];
  const login = new Map(
    spec.roles.filter((r) => r.access === "login" && r.isAdmin !== true).map((r) => [r.name, r]),
  );
  for (const [i, e] of spec.entities.entries()) {
    if (e.name === USERS_ENTITY || !e.fields.some((f) => f.type === "text")) continue;
    const perms = spec.permissions.filter((p) => p.entity === e.name && login.has(p.role));
    const writers = perms.filter((p) => p.ops.includes("create")).map((p) => p.role);
    const readers = perms.filter((p) => p.ops.includes("read")).map((p) => p.role);
    const pair = writers.flatMap((w) => readers.filter((r) => r !== w).map((r) => [w, r] as const))[0];
    if (!pair) continue;
    out.push({
      message_ru: `«${e.label}»: пользователи одной роли пишут тексты, которые читает другая роль — перед публикацией систему посмотрит модератор`,
      path: `/entities/${i}`,
      evidence: `ori_signal: create ${pair[0]} → read ${pair[1]}; founder_review`,
      fixHint: "Предупреждение, публикацию не блокирует: нужна ручная проверка (149-ФЗ ст. 10.1, E-LEGAL)",
    });
  }
  return out;
}
