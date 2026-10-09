#!/usr/bin/env node
// Pilot on Timeweb Cloud from a GitHub-hosted runner, no self-hosted runner and no hand-made files
// (docs/ops/deploy.md «Пилот: одна кнопка», docs/reviews/impl-notes/pilot-bootstrap.md). The founder sets GitHub
// secrets/variables once (FOUNDER_INPUTS); everything else is created here, idempotently:
//   node tools/deploy/pilot.mjs check --env prod|staging                read-only preflight of the founder inputs
//        (tools/deploy/preflight.mjs): Timeweb token, balance and DNS zones, Cloud.ru, Z.ai, SMTP login or the
//        Unisender Go API key, alerts, SPF, the stock photo keys (B2-38)
//   node tools/deploy/pilot.mjs bootstrap --env prod|staging --tag <sha>   state bucket + keys (Timeweb API) → secrets
//        bundle (generated once, encrypted with WIZARD_STATE_PASSPHRASE, kept in the state bucket) → OpenTofu →
//        temporary SSH rule for this runner's IP → k3s over an SSH tunnel → addons, Secrets, Helm → founder access;
//        after the loss of the VM the same command recreates it (PostgreSQL restores itself from WAL-G, .data is
//        restored by a Job)
//   node tools/deploy/pilot.mjs deploy --env … --tag <sha>      release of a SHA (no OpenTofu apply, no addons)
//   node tools/deploy/pilot.mjs destroy --env staging            staging on demand: everything goes
//   node tools/deploy/pilot.mjs eval --env … [--briefs all|mvp-01,…] [--threshold d76|d67] --wave A --purpose …
//        --hypothesis … --expect-rub 200 --cap-rub 300 [--founder-ok yes]
//        measurement (docs/ops/eval-d76.md, eval-d67.md): a service account in the platform database over the SSH
//        tunnel, the briefs through the public HTTPS of the platform, then costs, «Запросы на развитие» and the session
//        revoked; report → summary. d76 (default, beta v2): strict threshold, plan approval, screenshots of each system.
//        V3-01: paid, so it starts only pre-registered in the spend journal (tools/deploy/spend.mjs); the cap stops it.
//        V3-18: --threshold v3 — checkpoint 1 of v3 (the v3-* briefs through the v3 path; the eval org must be on v3:
//        WIZARD_BUILD_PIPELINE_ORGS=eval on the server, checked before anything is spent)
//        V3-40: --threshold v3-final — the final measurement (12 briefs, screenshots at 390 and 1440 px, the site
//        fingerprints in collect): the run report v3-final-run-<date> and, for the full set, the report by the plan §6
//        v3-final-<date> (the blind comparison waits for the raters; retries of failed briefs are merged by `final`)
//   node tools/deploy/pilot.mjs v3-probe --env … --wave A --purpose … --hypothesis … --expect-rub 5 --cap-rub 30
//        V3-18: one minimal real call per v3 callType route head through the server's gateway (worker pod, usage of an
//        eval org in platform.llm_calls): status, model served, tier, scrub, latency, ₽; cap ≤ 30 ₽, pre-registered.
//        --shape critic,techreview: the production request shapes of critic_visual / techreview on synthetic content,
//        model by model of the chain, with variants of analysis and the provider's own words on a refusal
//        (tools/eval/server/probe-shape.mjs)
//   node tools/deploy/pilot.mjs close-access --env …             removes temporary SSH rules (workflow `always()`)
//   node tools/deploy/pilot.mjs show-secrets --env …             founder's laptop only: prints the decrypted bundle
// The heavy lifting is tools/deploy/infra.mjs (main with deps.hooks); this file only adds what the founder used to do
// by hand. Workflows: .github/workflows/bootstrap-pilot.yml, deploy-pilot.yml, eval-pilot.yml (owner only, pilot-reusable.yml).
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureDiversity } from "../eval/blind/diversity.mjs";
import { objectUrl, putObject, sha256Hex, signRequest } from "../eval/lib/s3.mjs";
import { selectBriefs } from "../eval/server/cli.mjs";
import { platformClient } from "../eval/server/client.mjs";
import { countedD76, isV3Threshold, runEval, THRESHOLDS } from "../eval/server/driver.mjs";
import {
  expectedProbeRub,
  PROBE_MAX_CAP_RUB,
  parseProbeOutput,
  probeAnnotations,
  probeScript,
  probeSpendSql,
  renderProbeReport,
} from "../eval/server/probe.mjs";
import {
  expectedShapeRub,
  parseShapeGroups,
  parseShapeOutput,
  renderShapeReport,
  shapeAnnotations,
  shapeScript,
} from "../eval/server/probe-shape.mjs";
import { githubProgress, progressText } from "../eval/server/progress.mjs";
import { evaluate, photosAnnotation, renderReport } from "../eval/server/report.mjs";
import { previewScreenshots, V3_FINAL_VIEWPORTS } from "../eval/server/screenshots.mjs";
import {
  collectSql,
  EVAL_MIN_BUILDS,
  evalCredits,
  newEvalSession,
  newRunId,
  parseCollectOutput,
  parseSeedOutput,
  revokeSql,
  seedSql,
} from "../eval/server/seed.mjs";
import { runV3Eval } from "../eval/server/v3.mjs";
import { mergeRuns, renderV3Final } from "../eval/server/v3-final.mjs";
import { checkpointName, finalName, finalRunName, renderV3Report } from "../eval/server/v3-report.mjs";
import { gvisorProbe, main as infraMain, NET_PROBE } from "./infra.mjs";
import {
  assertPassphrase,
  clusterSecretFiles,
  decryptBundle,
  encryptBundle,
  ensureBundle,
  MIN_PASSPHRASE,
  pilotStockMode,
  STOCK_KEY_ENV,
  STOCK_KEY_MODES,
  secretValues,
} from "./pilot-secrets.mjs";
import {
  runPreflight,
  SECRET_NAMES,
  stockAnnotation,
  stockKeyVerdicts,
  stockVerdictLine,
} from "./preflight.mjs";
import { capGuard, JOURNAL, moscowDate, preregister, readJournal, spendLine } from "./spend.mjs";

export const COMMANDS = [
  "check",
  "bootstrap",
  "deploy",
  "destroy",
  "diagnose",
  "eval",
  "v3-probe",
  "reboot",
  "close-access",
  "show-secrets",
];
export const ENVS = ["prod", "staging"];
export const TWC_API = "https://api.timeweb.cloud";
/** Timeweb S3 (only location ru-1): the state bucket, as the backend of infra/tofu/timeweb/envs/*. */
export const S3 = { endpoint: "https://s3.twcstorage.ru", region: "ru-1" };
export const STATE_BUCKET = "wizard-tfstate";
export const bundleKey = (env) => `wizard/${env}.secrets.enc.json`;
/** Description prefix of the temporary SSH rules: everything with it is removed at the start and the end of a job. */
export const TEMP_RULE_PREFIX = "wizard-ci-temp";
export const PLATFORM_NS = "wizard-platform";

/**
 * Shape of the pilot per environment (deploy.yaml#pilot.environments): Cloud MSK 80 for prod, MSK 50 for staging;
 * max_price caps the preset search (growth beyond it is a reviewed change of this table, ≤ 20 000 ₽/month).
 */
export const SHAPES = {
  prod: { server: { cpu: 4, ram_gb: 8, disk_gb: 80, max_price: 2000 }, buckets: { files: 10, backups: 100 } },
  staging: {
    server: { cpu: 2, ram_gb: 4, disk_gb: 50, max_price: 1100 },
    buckets: { files: 10, backups: 10 },
  },
};

/** What the founder sets in GitHub (Settings → Secrets and variables → Actions, repository or environment level). */
export const FOUNDER_INPUTS = {
  secrets: [
    ["TWC_TOKEN", "API-токен Timeweb Cloud (без подтверждения удаления через Telegram)", true],
    ["WIZARD_STATE_PASSPHRASE", `пароль из менеджера паролей, ≥ ${MIN_PASSPHRASE} символов`, true],
    ["CLOUDRU_API_KEY", "ключ Cloud.ru Foundation Models", true],
    ["ZAI_API_KEY", "ключ Z.ai (необязательно)", false],
    ["WIZARD_SMTP_HOST", "SMTP-сервер почты платформы (коды входа)", true],
    ["WIZARD_SMTP_PORT", "порт SMTP (по умолчанию 465)", false],
    ["WIZARD_SMTP_USER", "логин SMTP", false],
    [
      "WIZARD_SMTP_PASSWORD",
      "пароль SMTP (у Unisender Go — API-ключ, по нему же идёт отправка через API)",
      false,
    ],
    ["WIZARD_SMTP_FROM", "отправитель, например «Wizard <noreply@домен>»", true],
    ["WIZARD_OPS_ALERT_TELEGRAM_TOKEN", "токен бота для алертов (или WIZARD_OPS_ALERT_URL)", false],
    ["WIZARD_OPS_ALERT_CHAT_ID", "чат Telegram для алертов", false],
  ],
  variables: [
    ["WIZARD_PLATFORM_DOMAIN", "домен платформы (в «Доменах» Timeweb Cloud)", true],
    ["WIZARD_SYSTEMS_DOMAIN", "домен систем клиентов (в «Доменах» Timeweb Cloud)", true],
    ["WIZARD_ACME_EMAIL", "почта для Let's Encrypt (по умолчанию — почта основателя)", false],
    ["WIZARD_FOUNDER_EMAIL", "почта основателя: вход, права staff, алерты", true],
  ],
};

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** Paid commands: they start only pre-registered in the spend journal (V3-01; v3-probe — V3-18). */
export const PAID = ["eval", "v3-probe"];

/** eval flags of the spend journal pre-registration (V3-01) → the fields of tools/deploy/spend.mjs preregister. */
const SPEND_FLAGS = {
  "--wave": "wave",
  "--purpose": "purpose",
  "--hypothesis": "hypothesis",
  "--expect-rub": "expectRub",
  "--cap-rub": "capRub",
  // The pre-V3 name of the cap (the measurement budget).
  "--max-cost-rub": "capRub",
  "--founder-ok": "founderOk",
};

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const o = { command, env: null, tag: null };
  const spend = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--env") o.env = rest[++i] ?? null;
    else if (a === "--tag") o.tag = rest[++i] ?? null;
    else if (command === "eval" && a === "--briefs") o.briefs = rest[++i] || "all";
    else if (command === "eval" && a === "--threshold") o.threshold = rest[++i] || "d76";
    // V3-18: the shape probe (production request shapes per model of the chain); empty — the route probe.
    else if (command === "v3-probe" && a === "--shape") o.shape = parseShapeGroups(rest[++i] ?? "");
    else if (PAID.includes(command) && SPEND_FLAGS[a]) spend[SPEND_FLAGS[a]] = rest[++i] ?? "";
    else throw new Error(`unknown argument ${a}`);
  }
  if (command === "v3-probe") {
    // V3-18: step 2 of the ladder — pre-registered like eval, never more than PROBE_MAX_CAP_RUB.
    o.spend = preregister(spend);
    if (o.spend.capRub > PROBE_MAX_CAP_RUB)
      throw new Error(`v3-probe: потолок пробы — не больше ${PROBE_MAX_CAP_RUB} ₽ (cap_rub)`);
    o.maxCostRub = o.spend.capRub;
    if (!o.shape) delete o.shape;
  }
  if (command === "eval") {
    o.briefs ??= "all";
    if (!/^(all|[a-z0-9-]+(,[a-z0-9-]+)*)$/.test(o.briefs))
      throw new Error("--briefs: all или id через запятую");
    // B2-41: the strict threshold of beta v2 by default; d67 stays for a repeat of the MVP measurement.
    o.threshold ??= "d76";
    if (!THRESHOLDS.includes(o.threshold)) throw new Error(`--threshold: ${THRESHOLDS.join(" | ")}`);
    // V3-01: a paid run only with its pre-registration; its cap is the budget of the measurement and a hard stop.
    o.spend = preregister(spend);
    o.maxCostRub = o.spend.capRub;
  }
  if (!COMMANDS.includes(o.command)) throw new Error(`command: ${COMMANDS.join(" | ")}`);
  if (!ENVS.includes(o.env)) throw new Error("--env prod|staging is required");
  if (o.command === "destroy" && o.env !== "staging")
    throw new Error("destroy: only staging (prod is never destroyed)");
  if (["bootstrap", "deploy"].includes(o.command) && !SHA.test(o.tag ?? ""))
    throw new Error("--tag: full commit SHA");
  return o;
}

/**
 * Settings of the target environment. Without GitHub Pro a private repository has no environment-level variables, so
 * staging takes its domains from WIZARD_STAGING_PLATFORM_DOMAIN / WIZARD_STAGING_SYSTEMS_DOMAIN; it never falls back to
 * the prod domains (a staging apply would rewrite the prod DNS records). Problems: [[name, why]].
 */
export function envVars(env, vars) {
  if (env !== "staging") return { vars, problems: [] };
  const problems = [];
  const out = { ...vars };
  for (const [name, from] of [
    ["WIZARD_PLATFORM_DOMAIN", "WIZARD_STAGING_PLATFORM_DOMAIN"],
    ["WIZARD_SYSTEMS_DOMAIN", "WIZARD_STAGING_SYSTEMS_DOMAIN"],
  ]) {
    const v = vars[from] ?? "";
    if (!v)
      problems.push([from, "не задан: отдельный домен staging (домены prod для staging не используются)"]);
    else if (v === vars.WIZARD_PLATFORM_DOMAIN || v === vars.WIZARD_SYSTEMS_DOMAIN)
      problems.push([from, "совпадает с доменом prod"]);
    out[name] = v;
  }
  return { vars: out, problems };
}

/** Missing or malformed founder inputs for a command: [[name, why]] (names only — values are never printed). */
export function checkInputs(command, vars) {
  const problems = [];
  const need = (name, hint) => {
    if (!vars[name]) problems.push([name, `не задан: ${hint}`]);
  };
  need("TWC_TOKEN", "API-токен Timeweb Cloud");
  if (command === "close-access") return problems;
  if (!vars.WIZARD_STATE_PASSPHRASE) need("WIZARD_STATE_PASSPHRASE", "пароль шифрования состояния и ключей");
  else if (vars.WIZARD_STATE_PASSPHRASE.length < MIN_PASSPHRASE)
    problems.push(["WIZARD_STATE_PASSPHRASE", `короче ${MIN_PASSPHRASE} символов`]);
  if (command === "show-secrets") return problems;
  for (const n of ["WIZARD_PLATFORM_DOMAIN", "WIZARD_SYSTEMS_DOMAIN"]) {
    if (!vars[n]) need(n, "домен, добавленный в Timeweb Cloud");
    else if (!DOMAIN.test(vars[n]))
      problems.push([n, "не похоже на домен (только строчные буквы, цифры, точки)"]);
  }
  const p = vars.WIZARD_PLATFORM_DOMAIN ?? "";
  const s = vars.WIZARD_SYSTEMS_DOMAIN ?? "";
  if (p && s && (p === s || p.endsWith(`.${s}`) || s.endsWith(`.${p}`)))
    problems.push([
      "WIZARD_SYSTEMS_DOMAIN",
      "должен быть отдельным доменом, не совпадать с доменом платформы",
    ]);
  if (command === "destroy") return problems;
  for (const [name, hint, required] of [...FOUNDER_INPUTS.secrets, ...FOUNDER_INPUTS.variables]) {
    if (required && !problems.some(([n]) => n === name)) need(name, hint);
  }
  for (const n of ["WIZARD_FOUNDER_EMAIL", "WIZARD_ACME_EMAIL"]) {
    if (vars[n] && !EMAIL.test(vars[n])) problems.push([n, "не похоже на адрес почты"]);
  }
  if (vars.WIZARD_SMTP_PORT && !/^\d{2,5}$/.test(vars.WIZARD_SMTP_PORT))
    problems.push(["WIZARD_SMTP_PORT", "нужен номер порта"]);
  if (
    vars.WIZARD_MAIL_TRANSPORT &&
    !["smtp", "unisender-api"].includes(vars.WIZARD_MAIL_TRANSPORT.trim().toLowerCase())
  )
    problems.push(["WIZARD_MAIL_TRANSPORT", "допустимо smtp или unisender-api"]);
  if (vars.WIZARD_OPS_ALERT_TELEGRAM_TOKEN && !vars.WIZARD_OPS_ALERT_CHAT_ID)
    problems.push(["WIZARD_OPS_ALERT_CHAT_ID", "нужен вместе с WIZARD_OPS_ALERT_TELEGRAM_TOKEN"]);
  if (!vars.WIZARD_GHCR_TOKEN && vars.WIZARD_GHCR_ANONYMOUS !== "1")
    problems.push([
      "WIZARD_GHCR_TOKEN",
      "токен GHCR read:packages (или публичные пакеты: WIZARD_GHCR_ANONYMOUS=1)",
    ]);
  return problems;
}

/** Image prefix in GHCR: ghcr.io/<owner, lower case> (WIZARD_IMAGE_REGISTRY overrides). */
export function imageRegistry(vars) {
  if (vars.WIZARD_IMAGE_REGISTRY) return vars.WIZARD_IMAGE_REGISTRY;
  const owner = (vars.GITHUB_REPOSITORY_OWNER ?? "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(owner)) throw new Error("GITHUB_REPOSITORY_OWNER: нет владельца репозитория");
  return `ghcr.io/${owner}`;
}

/**
 * tfvars of infra/tofu/timeweb/envs/<env> (JSON): the pilot shape, the founder's domains, the generated SSH key.
 * admin_cidrs stays empty — SSH is opened per job by openAdminAccess and closed again, nothing is open in between.
 */
export function tfvars(env, vars, sshPublicKey, server = null) {
  return {
    settings: {
      ...SHAPES[env],
      // A VM the founder handed over (resolvePilotServer): adopted, not created; no region search.
      ...(server ? { existing_server: { id: server.id, ip: server.ip } } : {}),
      sandbox_nodes: {},
      postgres: null,
      image_registry: imageRegistry(vars),
      ssh_public_key: sshPublicKey,
      admin_cidrs: [],
      platform_domain: vars.WIZARD_PLATFORM_DOMAIN,
      systems_domain: vars.WIZARD_SYSTEMS_DOMAIN,
      ...(vars.WIZARD_PLATFORM_MAIL_SPF ? { platform_mail_spf: vars.WIZARD_PLATFORM_MAIL_SPF } : {}),
      // Region of the VM: Moscow (ru-3) unless the GitHub variable WIZARD_TIMEWEB_LOCATION says ru-1 (St Petersburg),
      // e.g. when Moscow answers «No free node» (first live apply, 2026-10-02).
      ...(["ru-1", "ru-3"].includes(vars.WIZARD_TIMEWEB_LOCATION)
        ? { location: vars.WIZARD_TIMEWEB_LOCATION }
        : {}),
      // Zone override (spb-1…spb-5, msk-1): when a preset is refused in the default zone of its location.
      ...(/^(spb-[1-5]|msk-1)$/.test(vars.WIZARD_TIMEWEB_ZONE ?? "")
        ? { zone: vars.WIZARD_TIMEWEB_ZONE }
        : {}),
    },
  };
}

/**
 * Tidy the two zones after OpenTofu (founder, 2026-10-02): Timeweb puts a default SPF and parking A records into a
 * new zone, and the provider's DKIM was first added at the root instead of <selector>._domainkey. Only these are
 * touched, each step checked first and logged (no secrets in DNS values here):
 *   - a root SPF other than ours is deleted once ours exists (two SPF records = SPF permerror);
 *   - root / wildcard A records not pointing at the ingress IP are deleted once one that does exists;
 *   - a root DKIM (v=DKIM1) is copied to <selector>._domainkey and deleted from the root only after the copy exists.
 * DMARC of the platform domain is the founder's and is never created, moved or deleted here.
 */
export async function tidyDns(api, { zones, ingressIp, ourSpf = {}, dkimSelector = "", log = () => {} }) {
  const done = [];
  // The API may give the subdomain short ("*") or full ("*.zone"); both are normalized per zone below.
  const sub = (r, zone) => {
    const v = String(r.data?.subdomain ?? "");
    return v === zone || v === "@" ? "" : v.endsWith(`.${zone}`) ? v.slice(0, -zone.length - 1) : v;
  };
  const val = (r) => String(r.data?.value ?? "").replace(/^"|"$/g, "");
  for (const zone of zones) {
    let records;
    try {
      ({ dns_records: records = [] } = await api("GET", `/api/v1/domains/${zone}/dns-records`));
    } catch (e) {
      log(`::warning title=pilot::DNS ${zone}: список записей недоступен (${e.message})`);
      continue;
    }
    const del = async (r, why) => {
      try {
        await api("DELETE", `/api/v1/domains/${zone}/dns-records/${r.id}`);
        done.push(`${zone}: удалена ${r.type} ${r.data?.subdomain || "@"} «${val(r).slice(0, 40)}» (${why})`);
      } catch (e) {
        log(
          `::warning title=pilot::DNS ${zone}: не удалось удалить ${r.type} ${val(r).slice(0, 40)} (${e.message})`,
        );
      }
    };
    const isRoot = (r) => sub(r, zone) === "";
    const rootTxt = records.filter((r) => r.type === "TXT" && isRoot(r));
    const spf = rootTxt.filter((r) => val(r).startsWith("v=spf1"));
    const ours = ourSpf[zone];
    if (ours && spf.some((r) => val(r) === ours))
      for (const r of spf) if (val(r) !== ours) await del(r, "вторая SPF-запись");
    for (const name of ["", "*"]) {
      const group = records.filter((r) => r.type === "A" && sub(r, zone) === name);
      if (ingressIp && group.some((r) => val(r) === ingressIp))
        for (const r of group) if (val(r) !== ingressIp) await del(r, `A не на сервер ${ingressIp}`);
    }
    const dkim = rootTxt.filter((r) => val(r).startsWith("v=DKIM1"));
    const target = `${dkimSelector}._domainkey.${zone}`;
    const placed = records.find((r) => r.type === "TXT" && sub(r, zone) === `${dkimSelector}._domainkey`);
    if (dkimSelector && dkim.length === 1 && placed) {
      // Already at its name (a rerun, or added in the panel): never a second copy; the root one goes only if equal.
      if (val(placed) === val(dkim[0])) await del(dkim[0], `DKIM уже есть в ${target}`);
    } else if (dkimSelector && dkim.length === 1) {
      try {
        await api("POST", `/api/v1/domains/${zone}/dns-records`, {
          type: "TXT",
          subdomain: target,
          value: val(dkim[0]),
        });
        done.push(`${zone}: DKIM скопирован в ${target}`);
        await del(dkim[0], `DKIM перенесён в ${target}`);
      } catch (e) {
        log(
          `::warning title=pilot::DNS ${zone}: DKIM не перенесён в ${target} (${e.message}) — оставлен в корне`,
        );
      }
    }
  }
  for (const line of done) log(`DNS: ${line}`);
  return done;
}

/**
 * `check`: the VM presets Timeweb offers for the pilot shape in each RF location, and the zones of each location —
 * data for picking a region/zone when a create fails («No free node», «location_zone … is not valid»). Read-only;
 * a failure is a warning.
 */
export async function reportServerOptions(api, shape, { log = () => {} } = {}) {
  try {
    const { server_presets: presets = [] } = await api("GET", "/api/v1/presets/servers");
    const fit = presets
      .filter((p) => String(p.location).startsWith("ru-"))
      .filter((p) => p.cpu === shape.cpu && p.ram === shape.ram_gb * 1024 && p.disk >= shape.disk_gb * 1024)
      .sort((a, b) => a.location.localeCompare(b.location) || a.price - b.price);
    log(
      `Тарифы ВМ ${shape.cpu} vCPU / ${shape.ram_gb} ГБ / от ${shape.disk_gb} ГБ (потолок ${shape.max_price} ₽):`,
    );
    for (const p of fit)
      log(
        `  ${p.location} id=${p.id} ${p.price} ₽ диск ${p.disk / 1024} ГБ ${p.disk_type ?? ""} CPU ${p.cpu_frequency ?? "?"} ГГц «${p.description_short ?? p.description ?? ""}» теги=${JSON.stringify(p.tags ?? [])}`,
      );
    const { locations = [] } = await api("GET", "/api/v2/locations").catch(() => ({ locations: [] }));
    for (const l of locations)
      log(
        `  локация ${l.location ?? l.code ?? JSON.stringify(l).slice(0, 40)}: зоны ${JSON.stringify(l.availability_zones ?? [])}`,
      );
  } catch (e) {
    log(`::warning title=pilot::Тарифы ВМ недоступны (${e.message})`);
  }
  await reportExistingServers(api, { log });
}

/** IPv4 addresses of a Timeweb server (public and VPC). */
function serverIps(s) {
  return (s.networks ?? []).flatMap((n) =>
    (n.ips ?? []).filter((i) => i.type === "ipv4").map((i) => `${n.type}:${i.ip}`),
  );
}

/**
 * Load of a server over the last `hours` and its latest events, from the Timeweb API (check; read-only): tells a hung
 * or overloaded VM (no SSH, no HTTP while the API says "on") from a network problem.
 */
export async function reportServerHealth(
  api,
  server,
  { log = () => {}, now = () => new Date(), hours = 2 } = {},
) {
  const iso = (d) => encodeURIComponent(d.toISOString().slice(0, 19));
  const to = now();
  const from = new Date(to.getTime() - hours * 3600_000);
  try {
    const stats = await api(
      "GET",
      `/api/v1/servers/${server.id}/statistics?date_from=${iso(from)}&date_to=${iso(to)}`,
    );
    for (const [key, rows] of Object.entries(stats)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const tail = rows.slice(-6).map((r) => {
        const at = String(r.logged_at ?? "").slice(11, 16);
        const vals = Object.entries(r)
          .filter(([k, v]) => k !== "logged_at" && typeof v === "number")
          .map(([k, v]) => `${k}=${Math.round(v * 10) / 10}`);
        return `${at} ${vals.join(" ")}`;
      });
      log(`  ${server.id} ${key}: ${tail.join(" | ")}`);
    }
  } catch (e) {
    log(`  ${server.id}: статистика недоступна (${e.message})`);
  }
  try {
    const { server_logs: logs = [] } = await api(
      "GET",
      `/api/v1/servers/${server.id}/logs?limit=8&order=desc`,
    );
    for (const l of logs)
      log(`  ${server.id} событие ${l.logged_at ?? ""} ${l.event ?? JSON.stringify(l).slice(0, 80)}`);
  } catch (e) {
    log(`  ${server.id}: журнал недоступен (${e.message})`);
  }
}

/**
 * Hard reboot of the environment's VM (bootstrap-pilot `reboot`, PROD word): the way back from a hung VM — no SSH,
 * no HTTP while the API says "on" (2026-10-03). PostgreSQL recovers from its WAL on start. Waits until "on" again.
 */
export async function rebootServer(
  api,
  server,
  {
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 10_000,
    waitMs = 600_000,
  } = {},
) {
  log(`сервер ${server.id} «${server.name ?? ""}»: жёсткая перезагрузка`);
  await api("POST", `/api/v1/servers/${server.id}/action`, { action: "hard_reboot" });
  let seenOff = false;
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    const s = (await api("GET", `/api/v1/servers/${server.id}`)).server?.status;
    if (s !== "on") seenOff = true;
    else if (seenOff || waited >= 60_000) {
      log(`сервер ${server.id}: снова включён`);
      return;
    }
  }
  throw new Error(`сервер ${server.id} не включился за ${waitMs / 60_000} мин после перезагрузки`);
}

/**
 * ACME challenges stuck in deletion (their cleanup kept failing — the DNS-01 solver bug of 2026-10-03) block every
 * new challenge for the same name: cert-manager retries the cleanup only every ~30 minutes. Those deleted more than
 * `minutes` ago lose their finalizer; the TXT records they could have left are the solver's (TTL 120 s) and harmless.
 */
export function releaseStuckChallenges({ kubectl, log = () => {}, now = () => new Date(), minutes = 10 }) {
  const r = kubectl(["get", "challenges.acme.cert-manager.io", "-A", "-o", "json"], {
    capture: true,
    allowFail: true,
    fake: "{}",
  });
  let items = [];
  try {
    items = JSON.parse(r.stdout || "{}").items ?? [];
  } catch {}
  for (const c of items) {
    const since = Date.parse(c.metadata?.deletionTimestamp ?? "");
    if (!Number.isFinite(since) || now().getTime() - since < minutes * 60_000) continue;
    const { name, namespace } = c.metadata;
    log(`ACME: снимаю зависший челлендж ${namespace}/${name} (${c.spec?.dnsName ?? ""})`);
    kubectl(
      [
        "-n",
        namespace,
        "patch",
        "challenges.acme.cert-manager.io",
        name,
        "--type=merge",
        "-p",
        '{"metadata":{"finalizers":[]}}',
      ],
      { allowFail: true },
    );
  }
}

/** Address records of the zones as Timeweb serves them (diagnose; read-only). */
export async function reportDns(api, zones, { log = () => {} } = {}) {
  for (const zone of zones) {
    try {
      const { dns_records: records = [] } = await api("GET", `/api/v1/domains/${zone}/dns-records`);
      for (const r of records.filter((x) => ["A", "AAAA", "CNAME"].includes(x.type)))
        log(`DNS ${zone}: ${r.type} ${r.data?.subdomain || "@"} → ${r.data?.value ?? ""}`);
    } catch (e) {
      log(`::warning title=pilot::DNS ${zone}: список записей недоступен (${e.message})`);
    }
  }
}

/** Public IPv4 of a Timeweb server (its floating IP when it has one). */
export const publicIpv4 = (s) =>
  (s?.networks ?? [])
    .filter((n) => n.type === "public")
    .flatMap((n) => (n.ips ?? []).filter((i) => i.type === "ipv4").map((i) => i.ip))[0] ?? "";

/**
 * The VM the founder handed over to the environment (founder, 2026-10-03), by id or public IP: workflow input
 * `server` (WIZARD_PILOT_SERVER) on the first run, then the encrypted bundle. It must be in the RF and at least the
 * shape of the environment. null → OpenTofu creates the VM.
 */
export async function resolvePilotServer(api, want, shape) {
  if (!want) return null;
  const { servers = [] } = await api("GET", "/api/v1/servers");
  const s = servers.find(
    (x) => String(x.id) === String(want) || serverIps(x).some((i) => i.endsWith(`:${want}`)),
  );
  if (!s) throw new Error(`сервер ${want} не найден в аккаунте Timeweb`);
  const disk = (s.disks ?? []).reduce((a, d) => a + (d.size ?? 0), 0);
  const small = s.cpu < shape.cpu || s.ram < shape.ram_gb * 1024 || disk < shape.disk_gb * 1024;
  if (small)
    throw new Error(
      `сервер ${s.id} меньше нужного: ${s.cpu} vCPU / ${s.ram / 1024} ГБ / ${disk / 1024} ГБ, нужно ${shape.cpu} / ${shape.ram_gb} / ${shape.disk_gb}`,
    );
  if (!String(s.location).startsWith("ru-")) throw new Error(`сервер ${s.id} не в РФ (${s.location})`);
  const ip = publicIpv4(s);
  if (!ip) throw new Error(`у сервера ${s.id} нет публичного IPv4`);
  return { id: Number(s.id), ip, name: s.name, location: s.location };
}

/** The account's existing servers and floating IPs (read-only): candidates for reuse and leftovers of failed runs. */
export async function reportExistingServers(api, { log = () => {} } = {}) {
  try {
    const { servers = [] } = await api("GET", "/api/v1/servers");
    log(`Серверы в аккаунте: ${servers.length}`);
    for (const s of servers) {
      const disk = (s.disks ?? []).reduce((a, d) => a + (d.size ?? 0), 0) / 1024;
      log(
        `  id=${s.id} «${s.name}» ${s.status} ${s.location}/${s.availability_zone ?? "?"} ${s.cpu} vCPU / ${s.ram / 1024} ГБ / ${disk} ГБ ОС ${s.os?.name ?? "?"} ${s.os?.version ?? ""} тариф=${s.preset_id ?? "-"} IP ${serverIps(s).join(", ")}`,
      );
      // Reachability as Timeweb sees it (never the root/VNC passwords of the same object).
      log(
        `    загрузка=${s.boot_mode ?? "?"} старт=${s.start_at ?? "?"} ddos=${s.is_ddos_guard ?? "?"} qemu-agent=${s.is_qemu_agent ?? "?"}`,
      );
      for (const n of s.networks ?? [])
        log(
          `    сеть ${n.type} nat=${n.nat_mode ?? "-"} полоса=${n.bandwidth ?? "?"} ddos=${n.is_ddos_guard ?? "-"} закрытые порты=${JSON.stringify(n.blocked_ports ?? [])}`,
        );
    }
    const { groups = [] } = await api("GET", "/api/v1/firewall/groups?limit=100").catch(() => ({
      groups: [],
    }));
    for (const g of groups) {
      const { rules = [] } = await api("GET", `/api/v1/firewall/groups/${g.id}/rules?limit=100`).catch(
        () => ({
          rules: [],
        }),
      );
      const { resources = [] } = await api(
        "GET",
        `/api/v1/firewall/groups/${g.id}/resources?limit=100`,
      ).catch(() => ({ resources: [] }));
      log(
        `  firewall «${g.name}» политика=${g.policy ?? "?"} ресурсы=${resources.map((r) => `${r.type}:${r.id}`).join(",") || "—"}`,
      );
      for (const r of rules)
        log(`    ${r.direction} ${r.protocol} ${r.port ?? "*"} ${r.cidr ?? ""} «${r.description ?? ""}»`);
    }
    const { ips = [] } = await api("GET", "/api/v1/floating-ips").catch(() => ({ ips: [] }));
    for (const f of ips)
      log(
        `  плавающий IP ${f.ip} ${f.availability_zone ?? ""} привязан к ${f.resource_type ?? "—"} ${f.resource_id ?? ""}`,
      );
  } catch (e) {
    log(`::warning title=pilot::Список серверов недоступен (${e.message})`);
  }
}

/** Timeweb out of capacity for this place (or the preset not offered there): try the next one (founder, 2026-10-02). */
export const CAPACITY_ERROR = /No free node|no available free IPs|location_zone: \S+ is not valid/i;

/**
 * Places for the pilot VM, all in the RF and with the same preset price ceiling: Moscow, then St Petersburg zones.
 * The run starts with the requested one (WIZARD_TIMEWEB_LOCATION / _ZONE), then goes down this list.
 */
export const PLACES = [
  { location: "ru-3", zone: "" },
  { location: "ru-1", zone: "spb-1" },
  { location: "ru-1", zone: "spb-4" },
  { location: "ru-1", zone: "spb-2" },
  { location: "ru-1", zone: "spb-5" },
];

export function placesFrom(vars) {
  const location = vars.WIZARD_TIMEWEB_LOCATION || "ru-3";
  // An empty zone means the module's default for a preset VM: spb-1 in St Petersburg, msk-1 (empty here) in Moscow.
  const first = { location, zone: vars.WIZARD_TIMEWEB_ZONE || (location === "ru-1" ? "spb-1" : "") };
  const rest = PLACES.filter((p) => !(p.location === first.location && p.zone === first.zone));
  return [first, ...rest];
}

export const DMARC_REJECT = "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s";

/**
 * The systems domain never sends mail: DMARC p=reject at _dmarc.<domain>, through the DNS records API (the OpenTofu
 * provider cannot create an underscore name). Best effort: a failure is a warning, never a stopped deploy.
 */
export async function ensureDmarc(api, domain, { log = () => {} } = {}) {
  try {
    const { dns_records: records = [] } = await api("GET", `/api/v1/domains/${domain}/dns-records`);
    if (JSON.stringify(records).includes("v=DMARC1")) return "exists";
    await api("POST", `/api/v1/domains/${domain}/dns-records`, {
      type: "TXT",
      subdomain: `_dmarc.${domain}`,
      value: DMARC_REJECT,
    });
    log(`DNS: _dmarc.${domain} TXT p=reject добавлена`);
    return "created";
  } catch (e) {
    log(
      `::warning title=pilot::DNS: не удалось добавить _dmarc.${domain} (${e.message}) — добавьте TXT «${DMARC_REJECT}» в панели Timeweb`,
    );
    return "failed";
  }
}

/** infra/dns/platform-records.json: provider records of the platform domain ({subdomain, type: CNAME|TXT, value}). */
export function platformDnsRecords(
  path = fileURLToPath(new URL("../../infra/dns/platform-records.json", import.meta.url)),
) {
  const { records = [] } = JSON.parse(readFileSync(path, "utf8"));
  for (const r of records)
    if (
      !/^[a-z0-9_]([a-z0-9_.-]{0,200}[a-z0-9])?$/i.test(String(r.subdomain)) ||
      !["CNAME", "TXT"].includes(r.type) ||
      typeof r.value !== "string" ||
      r.value.length === 0 ||
      r.value.length > 1024
    )
      throw new Error(
        `infra/dns/platform-records.json: запись ${JSON.stringify(r).slice(0, 120)} — нужны subdomain, type CNAME|TXT, value`,
      );
  return records;
}

/**
 * Creates the missing records of `records` in the zone (one per subdomain+type+value; nothing is deleted or changed:
 * a different value under the same name is reported for the founder). Failures are warnings.
 */
export async function ensureDnsRecords(api, domain, records, { log = () => {} } = {}) {
  if (records.length === 0) return [];
  let existing;
  try {
    ({ dns_records: existing = [] } = await api("GET", `/api/v1/domains/${domain}/dns-records`));
  } catch (e) {
    log(`::warning title=pilot::DNS ${domain}: список записей недоступен (${e.message})`);
    return [];
  }
  const sub = (r) => {
    const v = String(r.data?.subdomain ?? "");
    return v.endsWith(`.${domain}`) ? v.slice(0, -domain.length - 1) : v;
  };
  const val = (v) =>
    String(v ?? "")
      .replace(/^"|"$/g, "")
      .replace(/\.$/, "");
  const out = [];
  for (const r of records) {
    const same = existing.filter((e) => e.type === r.type && sub(e) === r.subdomain);
    if (same.some((e) => val(e.data?.value) === val(r.value))) {
      out.push(`${r.subdomain} ${r.type}: есть`);
      continue;
    }
    if (same.length > 0 && r.type === "CNAME") {
      log(
        `::warning title=pilot::DNS ${domain}: у ${r.subdomain} уже другой CNAME — проверьте в панели Timeweb`,
      );
      out.push(`${r.subdomain} ${r.type}: другое значение`);
      continue;
    }
    try {
      await api("POST", `/api/v1/domains/${domain}/dns-records`, {
        type: r.type,
        subdomain: `${r.subdomain}.${domain}`,
        value: r.value,
      });
      out.push(`${r.subdomain} ${r.type}: добавлена`);
    } catch (e) {
      log(
        `::warning title=pilot::DNS ${domain}: не удалось добавить ${r.subdomain} ${r.type} (${e.message})`,
      );
      out.push(`${r.subdomain} ${r.type}: ошибка`);
    }
  }
  for (const line of out) log(`DNS ${domain}: ${line}`);
  return out;
}

/** Unisender Go API base from the SMTP host (smtp.goN.unisender.ru → https://goN.unisender.ru) or WIZARD_MAIL_API_BASE. */
export function unisenderApiBase(vars) {
  const explicit = String(vars.WIZARD_MAIL_API_BASE ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;
  const m = /^smtp\.(go\d+)\.unisender\.ru\.?$/i.exec(String(vars.WIZARD_SMTP_HOST ?? "").trim());
  return m ? `https://${m[1].toLowerCase()}.unisender.ru` : "https://goapi.unisender.ru";
}

/**
 * The sender domain of the platform's mail confirmed at Unisender Go (2026-10-06: sends answered 1574 «use address
 * from a confirmed domain» — the ownership TXT was at the root, the DKIM at us._domainkey was missing). The records
 * come from domain/get-dns-records (public DNS values, no secrets): the ownership TXT at the root is only checked
 * (the Timeweb API here adds subdomain records), the DKIM TXT «k=rsa; p=<key>» goes to us._domainkey; then
 * Unisender is asked to re-check both. Every step is a warning at worst — mail never blocks a release.
 */
export async function ensureUnisenderDomain(api, { vars, fetch: f = fetch, log = () => {} }) {
  const host = String(vars.WIZARD_SMTP_HOST ?? "");
  const key = String(vars.WIZARD_SMTP_PASSWORD ?? "");
  const fromRaw = String(vars.WIZARD_SMTP_FROM ?? "");
  const domain = ((/<([^>]+)>/.exec(fromRaw)?.[1] ?? fromRaw).split("@")[1] ?? "").trim().toLowerCase();
  if (!/(^|\.)unisender\.ru\.?$/i.test(host) || !key || !domain) return null;
  const base = unisenderApiBase(vars);
  const call = async (method) => {
    const r = await f(`${base}/ru/transactional/api/v1/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "X-API-KEY": key },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    return {
      ok: r.ok && j.status === "success",
      code: j.code,
      message: String(j.message ?? "").slice(0, 160),
      j,
    };
  };
  let rec;
  try {
    rec = await call("domain/get-dns-records");
  } catch (e) {
    log(`::warning title=pilot::Unisender ${domain}: записи домена недоступны (${e.message})`);
    return null;
  }
  if (!rec.ok || !rec.j.dkim) {
    log(
      `::warning title=pilot::Unisender ${domain}: записи домена не получены (код ${rec.code ?? "—"} ${rec.message})`,
    );
    return null;
  }
  const out = await ensureDnsRecords(
    api,
    domain,
    [{ type: "TXT", subdomain: "us._domainkey", value: `k=rsa; p=${rec.j.dkim}` }],
    {
      log,
    },
  );
  let rootTxt = [];
  try {
    const { dns_records: all = [] } = await api("GET", `/api/v1/domains/${domain}/dns-records`);
    rootTxt = all
      .filter((r) => r.type === "TXT" && ["", "@", domain].includes(String(r.data?.subdomain ?? "")))
      .map((r) => String(r.data?.value ?? "").replace(/^"|"$/g, ""));
  } catch {}
  const verification = String(rec.j["verification-record"] ?? "");
  if (verification && !rootTxt.includes(verification))
    log(
      `::warning title=pilot::Unisender ${domain}: в корне нет TXT подтверждения владения «${verification}» — добавьте его в панели Timeweb`,
    );
  const checks = {};
  for (const m of ["domain/validate-verification-record", "domain/validate-dkim"]) {
    try {
      const r = await call(m);
      checks[m] = r.ok ? "подтверждено" : `не подтверждено (код ${r.code ?? "—"} ${r.message})`;
    } catch (e) {
      checks[m] = `ошибка (${e.message})`;
    }
    log(`Unisender ${domain}: ${m.split("/")[1]} — ${checks[m]}`);
  }
  return { dns: out, checks };
}

/** Timeweb Cloud API client: JSON in/out, bearer token; errors carry the method, path and status, never the token. */
export function twcClient({
  token,
  fetch: f = fetch,
  base = TWC_API,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  return async function api(method, path, body) {
    const send = () =>
      f(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    // A keep-alive socket idle for the whole release is closed by Timeweb's side: the next call fails before any
    // response ("fetch failed" when closing SSH, pilot 2026-10-04). Idempotent calls are sent again on a fresh one.
    let r;
    for (let i = 0; ; i++) {
      try {
        r = await send();
        break;
      } catch (e) {
        if (method === "POST" || i >= 2) throw e;
        await sleep(1000 * (i + 1));
      }
    }
    if (r.status === 204) return {};
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        msg = [j.error_code, j.message].flat().filter(Boolean).join(": ") || msg;
      } catch {}
      throw new Error(`Timeweb API ${method} ${path.split("?")[0]}: HTTP ${r.status} ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  };
}

/** A bucket's full name carries a random prefix: "1a2b3c4d-wizard-tfstate" (twc_s3_bucket.full_name). */
export const bucketMatches = (full, name) =>
  full === name || new RegExp(`^[0-9a-z]+-${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(full);

/**
 * The state bucket and its S3 keys, created when missing (private, the cheapest hot preset of ru-1). Idempotent: a
 * second run finds it by name. Returns {bucket (full name), accessKeyId, secretAccessKey, created} or null when it is
 * missing and `create` is false.
 */
export async function ensureStateBucket(
  api,
  {
    name = STATE_BUCKET,
    create = true,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    attempts = 20,
    log = () => {},
  } = {},
) {
  const { buckets = [] } = await api("GET", "/api/v1/storages/buckets");
  const found = buckets.filter((b) => bucketMatches(b.name, name));
  if (found.length > 1)
    throw new Error(`несколько бакетов ${name}: оставьте один (${found.map((b) => b.name)})`);
  let b = found[0];
  let created = false;
  if (!b) {
    if (!create) return null;
    const { storages_presets: presets = [] } = await api("GET", "/api/v1/presets/storages");
    const preset = presets
      .filter((p) => p.location === "ru-1" && (p.storage_class ?? "hot") === "hot")
      .sort((x, y) => x.price - y.price || x.disk - y.disk)[0];
    if (!preset) throw new Error("Timeweb API: нет тарифа S3 в ru-1");
    log(`создаю бакет состояния ${name} (тариф ${preset.id})`);
    b = (
      await api("POST", "/api/v1/storages/buckets", {
        name,
        type: "private",
        preset_id: preset.id,
        description: "Wizard: состояние OpenTofu и зашифрованные ключи пилота",
      })
    ).bucket;
    created = true;
  }
  for (let i = 1; b.status !== "created"; i++) {
    if (b.status === "no_paid") throw new Error("бакет состояния не оплачен: пополните баланс Timeweb Cloud");
    if (i > attempts) throw new Error(`бакет ${b.name} не готов (статус ${b.status})`);
    await sleep(15_000);
    b = (await api("GET", `/api/v1/storages/buckets/${b.id}`)).bucket;
  }
  if (!b.access_key || !b.secret_key) throw new Error(`Timeweb API: у бакета ${b.name} нет ключей S3`);
  return {
    bucket: b.name,
    accessKeyId: b.access_key,
    secretAccessKey: b.secret_key,
    created,
    // Timeweb answers GET of a missing key with 403 (S3 semantics without list rights), so an empty bucket — per the
    // API's own count — is what tells "no bundle yet" apart from a real access problem.
    empty: created || b.object_amount === 0,
  };
}

export const stateS3 = (state) => ({
  ...S3,
  bucket: state.bucket,
  accessKeyId: state.accessKeyId,
  secretAccessKey: state.secretAccessKey,
  empty: Boolean(state.empty),
});

/** S3 ListBuckets with a key pair: {names} or {code} (the S3 error code, or HTTP status) — never throws on 4xx. */
export async function listBuckets(cfg, { fetch: f = fetch, now = () => new Date() } = {}) {
  const url = new URL(`${cfg.endpoint}/`);
  const { host: _host, ...headers } = signRequest({
    method: "GET",
    url,
    payloadHash: sha256Hex(""),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now(),
  });
  const r = await f(url, { method: "GET", headers });
  const text = await r.text();
  if (!r.ok) return { code: s3ErrorCode(text).slice(2, -1) || `HTTP ${r.status}` };
  return { names: [...text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]) };
}

/**
 * The state bucket as S3 sees it. The first apply showed that the bucket's own key pair in the Timeweb API is refused
 * by S3 (SignatureDoesNotMatch) and that the API name may lack the random prefix of the real bucket. So: try the
 * bucket's keys, then each storage user's (GET /api/v1/storages/users), and take the first pair whose ListBuckets
 * shows the bucket (the exact name or "<prefix>-<name>"). Errors name each attempt's S3 code, never a key.
 */
export async function resolveStateS3(api, state, { fetch: f = fetch, now, log = () => {}, vars = {} } = {}) {
  const pairs = [
    [
      "ключ S3 аккаунта (секреты AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)",
      vars.WIZARD_S3_ACCOUNT_KEY_ID,
      vars.WIZARD_S3_ACCOUNT_SECRET,
    ],
    ["ключи бакета", state.accessKeyId, state.secretAccessKey],
  ];
  try {
    const { users = [] } = await api("GET", "/api/v1/storages/users");
    for (const u of users) pairs.push([`пользователь хранилища ${u.id}`, u.access_key, u.secret_key]);
  } catch (e) {
    log(`::warning::Timeweb API: пользователи хранилища недоступны (${e.message})`);
  }
  const tried = [];
  for (const [label, rawId, rawSecret] of pairs) {
    const accessKeyId = String(rawId ?? "").trim();
    const secretAccessKey = String(rawSecret ?? "").trim();
    if (!accessKeyId || !secretAccessKey) continue;
    if (tried.some(([, id, sec]) => id === accessKeyId && sec === secretAccessKey)) continue;
    const res = await listBuckets({ ...S3, accessKeyId, secretAccessKey }, { fetch: f, now });
    const bucket = res.names?.find((n) => bucketMatches(n, state.bucket) || bucketMatches(n, STATE_BUCKET));
    tried.push([label, accessKeyId, secretAccessKey, res.code ?? (bucket ? "ok" : "нет бакета в списке")]);
    if (bucket) {
      if (label !== "ключи бакета" || bucket !== state.bucket)
        log(`S3: бакет ${bucket}, доступ через ${label}`);
      return { ...state, bucket, accessKeyId, secretAccessKey };
    }
  }
  const err = new Error(
    `S3 не пускает к бакету ${state.bucket}: ${tried.map(([l, , , c]) => `${l} — ${c}`).join("; ") || "нет ключей"}`,
  );
  err.status = 403; // a just created bucket may need a moment: untilS3Ready retries
  throw err;
}

/** GET of an object, null when it does not exist (404). */
export async function getObjectOrNull(cfg, key, { fetch: f = fetch, now = () => new Date() } = {}) {
  const url = objectUrl(cfg, key);
  const { host: _host, ...headers } = signRequest({
    method: "GET",
    url,
    payloadHash: sha256Hex(""),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now(),
  });
  const r = await f(url, { method: "GET", headers });
  if (r.status === 404) return null;
  if (r.status === 403 && cfg.empty) return null;
  if (!r.ok) {
    const err = new Error(`S3 GET ${cfg.bucket}/${key}: HTTP ${r.status}${s3ErrorCode(await r.text())}`);
    err.status = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer()).toString("utf8");
}

/** " (<Code>)" of an S3 XML error body — codes carry no secrets (messages may echo the key id, so they are dropped). */
export function s3ErrorCode(body) {
  const m = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(String(body ?? ""));
  return m ? ` (${m[1]})` : "";
}

/**
 * A just created bucket's S3 keys start working with a delay (the first bootstrap got 403): retry 403 for up to
 * `attempts` × 15 s, then rethrow. Other errors are not retried.
 */
export async function untilS3Ready(
  fn,
  { attempts = 12, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {},
) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 403 || i >= attempts) throw e;
      if (i === 1) log("ключи S3 нового бакета ещё не действуют — жду (до 3 мин)");
      await sleep(15_000);
    }
  }
}

/**
 * The environment's bundle: read and decrypted when it exists (a wrong passphrase stops everything — nothing is
 * regenerated or overwritten), otherwise generated when `create`; missing values are added and the result written
 * back and read again. Returns {bundle, existed, added}.
 */
export async function loadBundle({ s3, env, passphrase, create, fetch: f, now, rand, kdf, log = () => {} }) {
  assertPassphrase(passphrase);
  const key = bundleKey(env);
  const text = await getObjectOrNull(s3, key, { fetch: f, now });
  const existing = text ? decryptBundle(text, passphrase, env) : null;
  if (!existing && !create) throw new Error(`нет ключей ${env} (${key}): сначала запустите bootstrap-pilot`);
  const { bundle, added } = ensureBundle(existing, env, { rand, now });
  if (added.length > 0) {
    await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf });
    log(
      `ключи ${env}: ${existing ? "дополнены" : "созданы"} (${added.join(", ")}), сохранены зашифрованными`,
    );
  }
  return { bundle, existed: Boolean(existing), added };
}

export async function saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf }) {
  const key = bundleKey(bundle.env);
  const text = encryptBundle(bundle, passphrase, { rand, ...(kdf ? { kdf } : {}) });
  await putObject(s3, key, text, { contentType: "application/json", fetch: f, now });
  // Read back as a non-empty bucket: a 403 now is a real access problem, never "missing".
  const back = await getObjectOrNull({ ...s3, empty: false }, key, { fetch: f, now });
  if (!back || JSON.stringify(decryptBundle(back, passphrase, bundle.env)) !== JSON.stringify(bundle))
    throw new Error(`ключи ${bundle.env}: записанный файл не совпал с прочитанным`);
}

/** Public IPv4 of this runner (the temporary SSH rule admits only it). */
export async function runnerIp(f = fetch) {
  for (const url of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
    try {
      const r = await f(url);
      const ip = (await r.text()).trim();
      if (r.ok && /^(\d{1,3})(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((x) => Number(x) <= 255))
        return ip;
    } catch {}
  }
  throw new Error("не удалось узнать внешний IPv4 раннера");
}

/** Firewall group of the environment's VM (infra/tofu/timeweb/modules/env: "<name_prefix>-nodes"). */
export async function findFirewall(api, env) {
  const { groups = [] } = await api("GET", "/api/v1/firewall/groups?limit=100");
  return groups.find((g) => g.name === `wizard-${env}-nodes`) ?? null;
}

/** Removes every temporary SSH rule of the environment; returns how many. */
export async function closeAdminAccess(api, env, { log = () => {} } = {}) {
  const g = await findFirewall(api, env);
  if (!g) return 0;
  const { rules = [] } = await api("GET", `/api/v1/firewall/groups/${g.id}/rules?limit=100`);
  const temp = rules.filter((r) => String(r.description ?? "").startsWith(TEMP_RULE_PREFIX));
  for (const r of temp) await api("DELETE", `/api/v1/firewall/groups/${g.id}/rules/${r.id}`);
  if (temp.length) log(`SSH закрыт: удалено временных правил — ${temp.length}`);
  return temp.length;
}

/**
 * SSH (tcp/22) to the VM from `ip`/32 only, for this job. Stale temporary rules (a killed job) go first; the k3s API
 * and the registry port are never opened — the API is reached through the SSH tunnel.
 */
export async function openAdminAccess(api, env, ip, { runId = "local", log = () => {} } = {}) {
  const g = await findFirewall(api, env);
  if (!g) throw new Error(`нет firewall wizard-${env}-nodes: OpenTofu его не создал`);
  if (g.policy && g.policy !== "DROP")
    log(
      `::warning::firewall wizard-${env}-nodes: политика ${g.policy}, а не DROP — проверьте в панели Timeweb`,
    );
  await closeAdminAccess(api, env);
  const { rule } = await api("POST", `/api/v1/firewall/groups/${g.id}/rules`, {
    direction: "ingress",
    protocol: "tcp",
    port: "22",
    cidr: `${ip}/32`,
    description: `${TEMP_RULE_PREFIX} ssh run ${runId}`,
  });
  log(`SSH открыт для ${ip}/32 на время задания`);
  return rule?.id ?? null;
}

/**
 * SQL of the founder access (psql variables only, fully qualified names): one founder invitation while the address has
 * no account (beta_readiness gates invitations of partners, not the operator's own account), then is_staff once the
 * founder has signed in. Prints the user id when staff is granted — the Job's exit condition.
 */
/** S3 client debug output without credentials (the Authorization header carries the access key id). */
export const redactS3Log = (text) =>
  String(text ?? "")
    .split("\n")
    .filter((l) => !/^\s*(Authorization|X-Amz-Security-Token):/i.test(l))
    .join("\n");

/**
 * `wal-g backup-list` from inside the running database container. On failure prints what WAL-G did (its stderr, the S3
 * requests it sent — the SDK logs them to stdout, which used to be dropped — and the Go resolver trace), then the
 * same network probe as diagnose from that pod's own network namespace. Returns whether the archive answered.
 */
export function checkArchive({ kubectl, log = console.log, bucket = "" }) {
  const exec = (cmd) =>
    kubectl(["-n", PLATFORM_NS, "exec", "wizard-postgres-0", "-c", "postgres", "--", ...cmd], {
      capture: true,
      allowFail: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const walg = exec([
    "env",
    "WALG_LOG_LEVEL=DEVEL",
    "S3_LOG_LEVEL=DEVEL",
    "GODEBUG=netdns=go+2",
    "timeout",
    "60",
    "wal-g",
    "backup-list",
  ]);
  if (walg.status === 0) {
    log("WAL-G: архив резервных копий доступен");
    return true;
  }
  log("::group::WAL-G backup-list: журнал и запросы S3");
  log(String(walg.stderr ?? "").slice(-4000));
  log(redactS3Log(walg.stdout).slice(-4000));
  log("::endgroup::");
  const probe = exec(["env", `PROBE_BUCKET=${bucket}`, "timeout", "40", "node", "-e", NET_PROBE]);
  log(
    `проба сети из пода postgres: ${`${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim() || `код ${probe.status}`}`,
  );
  log(
    `::warning title=pilot::WAL-G не получил список копий из архива (код ${walg.status}): архивирование WAL не работает, см. лог выше`,
  );
  return false;
}

/**
 * Pilot credits of the founder's own org «Wizard» at the first sign-in: payments are off on the pilot, so with 0 the
 * founder could not try a single build before granting himself credits in /admin (found by the local rehearsal). A few
 * builds' worth; more — /admin «Пилот» → «Начислить» or `pilot grant`.
 */
export const FOUNDER_START_CREDITS = 300;

export const FOUNDER_STAFF_SQL = `
UPDATE platform.pilot_invites SET revoked_at = now()
 WHERE email = lower(:'email') AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now();
INSERT INTO platform.pilot_invites (email, org_name, credits, expires_at)
SELECT lower(:'email'), 'Wizard', ${FOUNDER_START_CREDITS}, now() + interval '30 days'
 WHERE NOT EXISTS (SELECT 1 FROM platform.users u WHERE u.email = lower(:'email') AND u.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM platform.pilot_invites i
                    WHERE i.email = lower(:'email') AND i.accepted_at IS NULL AND i.revoked_at IS NULL);
UPDATE platform.orgs o SET kind = 'staff'
 WHERE o.kind = 'client'
   AND o.id IN (SELECT m.org_id FROM platform.memberships m JOIN platform.users u ON u.id = m.user_id
                 WHERE m.role = 'owner' AND u.email = lower(:'email') AND u.deleted_at IS NULL);
UPDATE platform.users SET is_staff = true
 WHERE email = lower(:'email') AND deleted_at IS NULL
RETURNING id;
`;

const FOUNDER_STAFF_LOOP = [
  "while :; do",
  '  out="$(printf "%s" "$FOUNDER_SQL" | psql -X -q -A -t -v ON_ERROR_STOP=1 -1 -v email="$FOUNDER_EMAIL" -f -)" && [ -n "$out" ] && {',
  '    echo \'{"level":"info","svc":"pilot","msg":"founder_staff_granted"}\'; exit 0; }',
  "  sleep 30",
  "done",
].join("\n");

export const FOUNDER_JOB = "wizard-founder-staff";

/**
 * One-off Job that waits for the founder's first sign-in and makes the account staff (MFA is enrolled on the first
 * visit of /admin) and the orgs it owns staff orgs (B2-01: no pilot limit, the staff reserve of the daily LLM cap). Runs as a pg-job pod (NetworkPolicy wizard-pg-job: only the database), image wizard-postgres.
 */
export function founderStaffJob({ image, email, pullSecret = "wizard-ghcr" }) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: FOUNDER_JOB,
      namespace: PLATFORM_NS,
      labels: { "app.kubernetes.io/part-of": "wizard" },
    },
    spec: {
      backoffLimit: 30,
      activeDeadlineSeconds: 30 * 24 * 3600,
      template: {
        metadata: { labels: { "wizard.ru/role": "pg-job", "app.kubernetes.io/part-of": "wizard" } },
        spec: {
          restartPolicy: "OnFailure",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          imagePullSecrets: [{ name: pullSecret }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "grant",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", FOUNDER_STAFF_LOOP],
              env: [
                { name: "PGHOST", value: `wizard-postgres.${PLATFORM_NS}.svc` },
                { name: "PGPORT", value: "5432" },
                { name: "PGUSER", value: "wizard" },
                { name: "PGDATABASE", value: "wizard" },
                {
                  name: "PGPASSWORD",
                  valueFrom: { secretKeyRef: { name: "wizard-postgres", key: "POSTGRES_PASSWORD" } },
                },
                { name: "FOUNDER_EMAIL", value: email },
                { name: "FOUNDER_SQL", value: FOUNDER_STAFF_SQL },
              ],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "200m", memory: "64Mi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * psql inside the database container (reached as diagnose reaches the cluster): the script goes through stdin, so
 * values never appear in the command line, which the runner prints. The password is the container's own variable.
 */
export const PSQL_IN_POD =
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -A -t -v ON_ERROR_STOP=1 -1 -f -';

export function psqlInPod(kubectl, sql) {
  const r = kubectl(
    ["-n", PLATFORM_NS, "exec", "-i", "wizard-postgres-0", "-c", "postgres", "--", "sh", "-c", PSQL_IN_POD],
    { input: sql, capture: true, allowFail: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    // The error line only: LINE/DETAIL/CONTEXT may echo the values of the statement.
    const why = String(r.stderr ?? "")
      .split("\n")
      .find((l) => /^(psql:.*)?ERROR:/.test(l.trim()));
    throw new Error(`psql в wizard-postgres-0: код ${r.status}${why ? `: ${why.trim().slice(0, 200)}` : ""}`);
  }
  return String(r.stdout ?? "");
}

/**
 * Mid-run counting of a brief for the fail-fast: as the report (a beyond-capability brief counts by the agent's honest
 * answer); D76 — the driver's verdict, the report re-checks the recorded out-of-scope requests in the database.
 */
export function runCounted(threshold) {
  if (threshold === "d76") return countedD76;
  return (r) => evaluate({ threshold, results: [r] }).items[0]?.counted === true;
}

/**
 * `eval` — the D67 measurement (product.yaml#decisions.D67_mvp_readiness, docs/ops/eval-d67.md): the service account
 * eval+<runid>@<platform domain> is created in the platform database (tools/eval/server/seed.mjs; the raw session
 * token is generated here, masked, and kept only in memory), the briefs run through the public HTTPS of the platform
 * like a client in the cabinet (tools/eval/server/driver.mjs), then the session is closed (logout, then revoked in the
 * database), the exact ₽ and «Запросы на развитие» are read, and the report goes to the job summary and to `outDir`
 * (uploaded as an artifact). The systems of the measurement stay for the founder. Exit 0 — the threshold is met,
 * 1 — not met. `o.threshold` d76 (B2-41, docs/ops/eval-d76.md): the strict threshold of beta v2 — the plan of each
 * system is approved as it is, G1 runs the goal scenarios in the browser, every system is shot at 390 and 1280 px
 * (artifact folder shots/), the budget is a hard stop.
 * V3-01 (D77 (18б), tools/deploy/spend.mjs): `o.spend` is the run's pre-registration (main checked it against the
 * wave plan of `journal`); its cap is the budget and a hard stop under any threshold (capGuard on the credits
 * estimate); the report, the summary, an annotation and the issue comment get «потрачено X ₽ из плана Y ₽ волны …»,
 * and the entry for the journal (spend-entry.json next to the report) — the orchestrator registers it.
 */
export async function pilotEval({
  o,
  vars,
  journal = null,
  log,
  fetch: f,
  now,
  rand,
  sleep,
  pollMs,
  maxBriefRub,
  outDir,
  inCluster,
  screenshots = previewScreenshots,
  v3Eval = null,
}) {
  const domain = vars.WIZARD_PLATFORM_DOMAIN;
  const base = `https://${domain}`;
  const threshold = o.threshold ?? "d67";
  const d76 = threshold === "d76";
  // V3-18: checkpoint 1 of v3 — the v3-* briefs through the v3 path, its own report and screenshots.
  // V3-40: v3-final — the same path on the final set of 12 briefs.
  const v3 = isV3Threshold(threshold);
  const final = threshold === "v3-final";
  const briefs = selectBriefs(o.briefs, final ? "v3-final" : v3 ? "v3" : "mvp");
  const label = v3 ? "V3" : d76 ? "D76" : "D67";
  const runid = newRunId(now(), rand);
  const session = newEvalSession(rand);
  mask([session.token, session.csrf], vars, log);
  const credits = evalCredits(o.maxCostRub);
  const sp = o.spend;
  const v3Since = vars.WIZARD_V3_BUDGET_SINCE || journal?.since;
  const registered = `волна ${sp.wave}, ожидаем ${sp.expectRub} ₽, потолок ${sp.capRub} ₽${sp.founderOk ? " («да» основателя)" : ""} — цель: ${sp.purpose}; гипотеза: ${sp.hypothesis}`;
  log(`::notice title=Журнал трат v3::${registered}`);
  log(
    `замер ${label} ${runid}: брифов ${briefs.length}, бюджет ${o.maxCostRub} ₽, учётке замера — ${credits} кредитов`,
  );
  let seed = null;
  const seeded = await inCluster(async ({ kubectl }) => {
    // V3-18: the eval org must start its systems on v3 — else every brief would pay an interview for nothing.
    if (v3) {
      const on = v3OrgsOfServer(kubectl);
      if (!on.eval) {
        log(
          `::error title=V3::На сервере организации замера не на v3: конвейер не v3, а WIZARD_BUILD_PIPELINE_ORGS ${on.value ? `= «${on.value}» без eval` : "не задан"}. Выкатите с build_pipeline=v3 (deploy-pilot), затем запустите замер снова. Ничего не потрачено.`,
        );
        return 2;
      }
      log(
        `v3 для организаций замера включён (${on.via === "pipeline" ? "WIZARD_BUILD_PIPELINE=v3" : `WIZARD_BUILD_PIPELINE_ORGS: ${on.value}`})`,
      );
    }
    seed = parseSeedOutput(
      psqlInPod(
        kubectl,
        seedSql({
          runid,
          domain,
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits,
          label,
        }),
      ),
    );
    log(`учётка замера создана: организация ${seed.orgId}`);
    return 0;
  });
  if (seeded !== 0 || !seed) return seeded || 1;
  // A cancelled job (SIGINT, then SIGTERM ~7 s later) stops the briefs at once: runs are cancelled, the report is
  // written from what the driver has, the database step is skipped (it would not finish before the kill).
  const stop = new AbortController();
  const onSignal = () => stop.abort("задание отменено");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const abortableSleep =
    sleep ??
    ((ms) =>
      new Promise((res) => {
        const t = setTimeout(res, ms);
        stop.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            res();
          },
          { once: true },
        );
      }));
  // Live progress in a GitHub issue (the job log is readable only after the job ends).
  const progress = githubProgress({ token: vars.GITHUB_TOKEN, repo: vars.GITHUB_REPOSITORY, fetch: f, log });
  const runUrl =
    vars.GITHUB_SERVER_URL && vars.GITHUB_REPOSITORY && vars.GITHUB_RUN_ID
      ? `${vars.GITHUB_SERVER_URL}/${vars.GITHUB_REPOSITORY}/actions/runs/${vars.GITHUB_RUN_ID}`
      : null;
  const startedAtMsk = now().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  const lines = [`журнал трат v3: ${registered}`];
  let snapshot = briefs.map((b) => ({ id: b.id, status: "pending", ready: false, costRubEstimate: 0 }));
  let stoppedWhy = null;
  const render = (finished = false) =>
    progressText({
      runId: runid,
      runUrl,
      startedAt: startedAtMsk,
      budgetRub: o.maxCostRub,
      results: snapshot,
      lines,
      stopped: stoppedWhy,
      finished,
    });
  const tee = (line) => {
    log(line);
    const t = now().toLocaleTimeString("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
    });
    lines.push(`${t} ${line}`);
    if (/замер остановлен/.test(line)) stoppedWhy = line.replace(/^.*замер остановлен:\s*/, "");
    progress?.publish(render(), { force: /готова|не готова|ошибка|остановлен/.test(line) });
  };
  stop.signal.addEventListener(
    "abort",
    () => {
      stoppedWhy = String(stop.signal.reason);
      progress?.publish(render(), { force: true });
    },
    { once: true },
  );
  const client = platformClient({ base, session, fetch: f, sleep: abortableSleep });
  // D76 and v3: PNGs of each system at 390 and 1280 px next to the report (artifact folder shots/, Chromium of packages/e2e).
  // V3-40: the final measurement shoots at 390 and 1440 px — the widths of the blind comparison and the template gate.
  const shots =
    d76 || v3
      ? screenshots({
          client,
          dir: join(outDir, "shots"),
          log,
          ...(final ? { viewports: V3_FINAL_VIEWPORTS } : {}),
        })
      : null;
  const shoot = shots
    ? async (r) => (await shots.screenshot(r)).map((x) => ({ ...x, src: `shots/${basename(x.src)}` }))
    : null;
  let doc;
  let db = {};
  const notes = [
    `Учётке замера начислено ${credits} кредитов, тариф «пилот», ревью основателя перед публикацией включено. Лимит D70 учётке замера поднят до ${EVAL_MIN_BUILDS} сборок, как это делается из /admin.`,
  ];
  // V3-01: the autostop at the cap — running briefs are cancelled at once (D67 alone only stops new ones); unlike a
  // cancelled job the database step still runs, so the exact spend reaches the report.
  const capStop = new AbortController();
  const overCap = capGuard(o.maxCostRub);
  try {
    doc = await (v3 ? (v3Eval ?? runV3Eval) : runEval)({
      client,
      briefs,
      orgId: seed.orgId,
      ownerEmail: seed.email,
      runId: runid,
      maxCostRub: o.maxCostRub,
      threshold,
      log: tee,
      sleep: abortableSleep,
      signal: AbortSignal.any([stop.signal, capStop.signal]),
      ...(v3 ? {} : { counted: runCounted(threshold) }),
      ...(shoot ? { screenshot: shoot } : {}),
      onUpdate: (results) => {
        snapshot = results;
        const why = capStop.signal.aborted
          ? null
          : overCap(results.reduce((s, x) => s + x.costRubEstimate, 0));
        if (why) {
          stoppedWhy = why;
          capStop.abort(why);
          log(`::warning title=Журнал трат v3::замер остановлен: ${why}`);
        }
        progress?.publish(render(), { force: Boolean(why) });
      },
      ...(pollMs ? { pollMs } : {}),
      ...(maxBriefRub ? { maxBriefRub } : {}),
    });
    if (doc.stopped) stoppedWhy = doc.stopped;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await shots?.close();
    await client
      .post("/auth/logout")
      .catch((e) => log(`::warning::выход учётки замера по API: ${e.message}`));
    await Promise.resolve()
      .then(() =>
        stop.signal.aborted
          ? notes.push(
              "Замер остановлен отменой задания: расход — оценка по кредитам, сессия закрыта выходом по API.",
            ) && 0
          : inCluster(async ({ kubectl }) => {
              try {
                db = parseCollectOutput(
                  psqlInPod(
                    kubectl,
                    // V3-01: eval spend since the first day of the v3 budget (the query of the B2 budget).
                    collectSql({ orgId: seed.orgId, b2Since: v3Since, v3, fingerprints: final }),
                  ),
                );
              } catch (e) {
                notes.push(
                  "Точный расход из журнала вызовов моделей прочитать не удалось — в отчёте оценка по кредитам.",
                );
                log(`::warning::расход замера из базы: ${e.message}`);
              }
              psqlInPod(kubectl, revokeSql({ tokenHash: session.tokenHash }));
              log("сессия учётки замера закрыта");
              return 0;
            }),
      )
      .catch((e) => log(`::warning::после замера: ${e.message} — сессия закрыта выходом по API`));
  }
  // The beta v2 budget line is gone with V3: the v3 budget is the journal's, its server part is in the spend section.
  const { b2: v3Server, ...reportDb } = db;
  const report = v3
    ? renderV3Report(doc, reportDb, { platform: base, notes, date: moscowDate(now()) })
    : renderReport(doc, reportDb, { platform: base, notes });
  const { summary } = report;
  const spend = evalSpend({
    spend: sp,
    journal,
    runid,
    summary,
    stopped: stoppedWhy,
    v3Server,
    now,
    ...(v3 ? { verdict: `готовы ${summary.ready} из ${summary.total}` } : {}),
  });
  const text = `${report.text}\n${spend.text}`;
  mkdirSync(outDir, { recursive: true });
  // V3-18: the checkpoint report under the name it gets in docs/progress (screenshots stay in the artifact).
  // V3-40: the final measurement — the run report v3-final-run-<date>.
  const name = final
    ? finalRunName(moscowDate(now()))
    : v3
      ? checkpointName(moscowDate(now()))
      : `${threshold}-${runid}`;
  writeFileSync(join(outDir, `${name}.md`), text);
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify({ ...doc, db }, null, 2)}\n`);
  writeFileSync(join(outDir, "spend-entry.json"), `${JSON.stringify(spend.entry, null, 2)}\n`);
  if (final)
    await finalExitReport({ doc, db: reportDb, journal, sp, summary, briefs, outDir, base, now, log });
  log(text);
  if (vars.GITHUB_STEP_SUMMARY) appendFileSync(vars.GITHUB_STEP_SUMMARY, `${text}\n`);
  log(`::notice title=Траты v3::${spend.line}`);
  if (doc?.results) snapshot = doc.results;
  await progress?.publish(
    `${render(true)}\n\n**Траты v3:** ${spend.line}.\n\n<details><summary>Отчёт</summary>\n\n${text.slice(0, 45_000)}\n</details>`,
    {
      force: true,
    },
  );
  // B2-41: the stock photos of the sites as an annotation (the job summary is not readable through the API).
  const photos = photosAnnotation(summary);
  if (photos) log(photos);
  if (!summary.passed)
    log(
      v3
        ? `::error title=V3::${final ? "Финальный замер" : "Чекпоинт 1"}: готовы ${summary.ready} из ${summary.total} — разбор по брифам в отчёте ${name}.md`
        : d76
          ? `::error title=D76::Строгий порог D76 не пройден: засчитано ${summary.ready} из ${summary.total} (нужно все)`
          : `::error title=D67::Порог D67 не достигнут: ${summary.ready} из ${summary.total} (нужно не меньше 7 из 10)`,
    );
  return summary.passed ? 0 : 1;
}

/**
 * V3-40: the report of the final measurement by the plan §6 next to the run report (v3-final-<date>.md): for a run of
 * the whole final set only — a retry of some briefs is merged with the first run by `cli.mjs final`, as the notice says.
 * The spend of this run is not in the journal yet (the orchestrator registers spend-entry.json): it is added as
 * extraRub. The blind comparison waits for the raters; the diversity is computed when the template gate's metric loads.
 */
async function finalExitReport({ doc, db, journal, sp, summary, briefs, outDir, base, now, log }) {
  const date = moscowDate(now());
  if (briefs.length < selectBriefs("all", "v3-final").length) {
    log(
      `::notice title=V3::Повтор части брифов финального замера: итог §6 — node tools/eval/server/cli.mjs final --results ${finalRunName("<дата первого прогона>")}.json,${finalRunName(date)}.json [--blind blind-summary.json] --out docs/progress/${finalName(date)}.md`,
    );
    return;
  }
  const merged = mergeRuns([{ doc, db }]);
  const diversity = await measureDiversity(merged.doc.results, merged.db);
  const { text } = renderV3Final(
    { ...merged, journal, extraRub: summary.costRub, blind: null, diversity },
    { date, platform: base, wave: sp.wave, shotsBase: "shots" },
  );
  writeFileSync(join(outDir, `${finalName(date)}.md`), text);
  log(`отчёт финального замера по критериям §6: ${finalName(date)}.md (слепое сравнение ждёт оценщиков)`);
}

/** The worker command that runs the probe script from stdin in the app folder of the worker image (tsx of the app). */
export const PROBE_IN_POD = ["node", "--import", "tsx", "--input-type=module", "-"];

/**
 * V3-18: is v3 on for the eval orgs of the server — WIZARD_BUILD_PIPELINE (v3 or empty: v3 is the default, D78) or
 * WIZARD_BUILD_PIPELINE_ORGS with eval, of the running worker (the env of its pod, the Secret of the release):
 * {value, eval, via: pipeline | orgs}. Read-only, no spend.
 */
export function v3OrgsOfServer(kubectl) {
  const r = kubectl(
    [
      "-n",
      PLATFORM_NS,
      "exec",
      "deploy/wizard-worker",
      "--",
      "node",
      "-e",
      'process.stdout.write(String(process.env.WIZARD_BUILD_PIPELINE ?? "") + "\\n" + String(process.env.WIZARD_BUILD_PIPELINE_ORGS || ""))',
    ],
    { capture: true, allowFail: true },
  );
  if (r.status !== 0) return { value: "", eval: false };
  const [pipeline = "", orgs = ""] = String(r.stdout ?? "").split("\n");
  const p = pipeline.trim().toLowerCase();
  if (p === "" || p === "v3") return { value: "", eval: true, via: "pipeline" };
  const value = orgs.trim();
  const items = value
    .toLowerCase()
    .split(",")
    .map((x) => x.trim());
  return { value, eval: items.includes("eval"), via: "orgs" };
}

/**
 * `v3-probe` (V3-18, step 2 of the ladder): an eval org «Замер V3 · <runid>» is created like the measurement's (its
 * session is revoked at once — the probe needs no cabinet), the probe script runs in the worker pod over stdin
 * (tools/eval/server/probe.mjs: the server's gateway, keys and policy; usage into platform.llm_calls of that org; the
 * cap stops it), the exact ₽ is read back from the database; the report, the summary, the annotations and the entry for
 * the spend journal as eval writes them. Exit 0 — every call answered, 1 — not.
 */
export async function pilotV3Probe({
  o,
  vars,
  journal = null,
  log,
  now,
  rand,
  outDir,
  inCluster,
  fake = false,
}) {
  const sp = o.spend;
  const runid = newRunId(now(), rand);
  const session = newEvalSession(rand);
  mask([session.token, session.csrf], vars, log);
  const registered = `волна ${sp.wave}, ожидаем ${sp.expectRub} ₽, потолок ${sp.capRub} ₽${sp.founderOk ? " («да» основателя)" : ""} — цель: ${sp.purpose}; гипотеза: ${sp.hypothesis}`;
  log(`::notice title=Журнал трат v3::${registered}`);
  log(
    `проба маршрутов v3 ${runid}: ожидаемо ≈ ${expectedProbeRub()} ₽ по ценам голов маршрутов, потолок ${sp.capRub} ₽`,
  );
  let probe = { calls: [], total: null };
  let exact = null;
  let orgId = null;
  const code = await inCluster(async ({ kubectl }) => {
    const seed = parseSeedOutput(
      psqlInPod(
        kubectl,
        seedSql({
          runid,
          domain: vars.WIZARD_PLATFORM_DOMAIN,
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits: evalCredits(sp.capRub),
          label: "V3",
        }),
      ),
    );
    orgId = seed.orgId;
    psqlInPod(kubectl, revokeSql({ tokenHash: session.tokenHash }));
    log(`организация пробы: ${orgId} (служебная, вид eval)`);
    const r = kubectl(["-n", PLATFORM_NS, "exec", "-i", "deploy/wizard-worker", "--", ...PROBE_IN_POD], {
      input: probeScript({ orgId, capRub: sp.capRub, fake }),
      capture: true,
      allowFail: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    probe = parseProbeOutput(r.stdout);
    if (r.status !== 0 || !probe.total) {
      const why = String(r.stderr ?? "")
        .split("\n")
        .find((l) => /Error|ошибк/i.test(l));
      log(
        `::warning title=V3 проба::скрипт пробы в поде worker завершился с кодом ${r.status}${why ? `: ${why.trim().slice(0, 200)}` : ""}`,
      );
    }
    try {
      exact = Number(String(psqlInPod(kubectl, probeSpendSql({ orgId }))).match(/probe_rub=([\d.]+)/)?.[1]);
    } catch (e) {
      log(`::warning::расход пробы из базы: ${e.message}`);
    }
    return 0;
  });
  if (code !== 0) return code;
  const date = moscowDate(now());
  const notes = [
    `Организация пробы \`${orgId}\` (вид eval): вызовы записаны в журнал вызовов моделей и входят в бюджет v3.`,
    Number.isFinite(exact)
      ? `Расход по журналу вызовов моделей: ${exact} ₽.`
      : "Расход из базы прочитать не удалось — в отчёте сумма по записям пробы.",
  ];
  const report = renderProbeReport(probe, {
    date,
    platform: `https://${vars.WIZARD_PLATFORM_DOMAIN}`,
    notes,
  });
  const summary = {
    ...report.summary,
    ...(Number.isFinite(exact) ? { costRub: exact, costExact: true } : {}),
  };
  const spend = evalSpend({
    spend: sp,
    journal,
    runid,
    summary,
    stopped: probe.total?.stopped ?? null,
    now,
    verdict: `ответили ${summary.ready} из ${summary.total}`,
  });
  const text = `${report.text}\n${spend.text}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `v3-probe-${date}-${runid}.md`), text);
  writeFileSync(
    join(outDir, `v3-probe-${date}-${runid}.json`),
    `${JSON.stringify({ runid, orgId, ...probe, exactRub: exact }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "spend-entry.json"), `${JSON.stringify(spend.entry, null, 2)}\n`);
  log(text);
  if (vars.GITHUB_STEP_SUMMARY) appendFileSync(vars.GITHUB_STEP_SUMMARY, `${text}\n`);
  for (const line of probeAnnotations(probe.calls ?? [])) log(line);
  log(`::notice title=Траты v3::${spend.line}`);
  if (!summary.passed)
    log(
      `::error title=V3 проба::Ответили ${summary.ready} из ${summary.total} маршрутов — разбор в отчёте пробы`,
    );
  return summary.passed ? 0 : 1;
}

/**
 * `v3-probe --shape` (V3-18): the shape probe (tools/eval/server/probe-shape.mjs) the way the route probe runs — an
 * eval org, the script in the worker pod over stdin (the request content travels inside it), the exact ₽ from the
 * database; the report, the summary, the annotations (one per call type and model) and the entry for the spend
 * journal. Exit 0 — every build shape worked, 1 — not (the variants say why).
 */
export async function pilotV3Shape({
  o,
  vars,
  journal = null,
  log,
  now,
  rand,
  outDir,
  inCluster,
  fake = false,
  fakeFail = [],
}) {
  const sp = o.spend;
  const runid = newRunId(now(), rand);
  const session = newEvalSession(rand);
  mask([session.token, session.csrf], vars, log);
  const registered = `волна ${sp.wave}, ожидаем ${sp.expectRub} ₽, потолок ${sp.capRub} ₽${sp.founderOk ? " («да» основателя)" : ""} — цель: ${sp.purpose}; гипотеза: ${sp.hypothesis}`;
  log(`::notice title=Журнал трат v3::${registered}`);
  const e = expectedShapeRub({ groups: o.shape });
  log(
    `проба формы запросов v3 ${runid} (${o.shape.join(", ")}): ожидаемо ≈ ${e.base} ₽, если формы как в сборке проходят; с вариантами разбора — до ≈ ${e.worst} ₽; потолок ${sp.capRub} ₽`,
  );
  let probe = { results: [], total: null };
  let exact = null;
  let orgId = null;
  const code = await inCluster(async ({ kubectl }) => {
    const seed = parseSeedOutput(
      psqlInPod(
        kubectl,
        seedSql({
          runid,
          domain: vars.WIZARD_PLATFORM_DOMAIN,
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits: evalCredits(sp.capRub),
          label: "V3",
        }),
      ),
    );
    orgId = seed.orgId;
    psqlInPod(kubectl, revokeSql({ tokenHash: session.tokenHash }));
    log(`организация пробы: ${orgId} (служебная, вид eval)`);
    const r = kubectl(["-n", PLATFORM_NS, "exec", "-i", "deploy/wizard-worker", "--", ...PROBE_IN_POD], {
      input: shapeScript({ orgId, capRub: sp.capRub, groups: o.shape, fake, fakeFail }),
      capture: true,
      allowFail: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    probe = parseShapeOutput(r.stdout);
    if (r.status !== 0 || !probe.total) {
      const why = String(r.stderr ?? "")
        .split("\n")
        .find((l) => /Error|ошибк/i.test(l));
      log(
        `::warning title=V3 форма::скрипт пробы в поде worker завершился с кодом ${r.status}${why ? `: ${why.trim().slice(0, 200)}` : ""}`,
      );
    }
    try {
      exact = Number(String(psqlInPod(kubectl, probeSpendSql({ orgId }))).match(/probe_rub=([\d.]+)/)?.[1]);
    } catch (err) {
      log(`::warning::расход пробы из базы: ${err.message}`);
    }
    return 0;
  });
  if (code !== 0) return code;
  const date = moscowDate(now());
  const unrecorded = Number(probe.total?.unrecordedRub ?? 0);
  const notes = [
    `Организация пробы \`${orgId}\` (вид eval): вызовы и прямые вызовы разбора записаны в журнал вызовов моделей и входят в бюджет v3.`,
    Number.isFinite(exact)
      ? `Расход по журналу вызовов моделей: ${exact} ₽.`
      : "Расход из базы прочитать не удалось — в отчёте сумма по записям пробы.",
    ...(unrecorded > 0
      ? [
          `Ещё ≈ ${unrecorded} ₽ — оценка ответов, которые шлюз отверг как NETWORK/EMPTY_RESPONSE (провайдер мог их выставить, в журнале 0 ₽); потолок их учитывал.`,
        ]
      : []),
  ];
  const report = renderShapeReport(probe, {
    date,
    platform: `https://${vars.WIZARD_PLATFORM_DOMAIN}`,
    notes,
  });
  const summary = {
    ...report.summary,
    ...(Number.isFinite(exact) ? { costRub: exact, costExact: true } : {}),
  };
  const spend = evalSpend({
    spend: sp,
    journal,
    runid,
    summary,
    stopped: probe.total?.stopped ?? null,
    now,
    verdict: `форма: как в сборке прошли ${summary.prodOk} из ${summary.prodTotal} моделей, вариантов годны ${summary.ready} из ${summary.total}`,
  });
  const text = `${report.text}\n${spend.text}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `v3-shape-${date}-${runid}.md`), text);
  writeFileSync(
    join(outDir, `v3-shape-${date}-${runid}.json`),
    `${JSON.stringify({ runid, orgId, ...probe, exactRub: exact }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "spend-entry.json"), `${JSON.stringify(spend.entry, null, 2)}\n`);
  log(text);
  if (vars.GITHUB_STEP_SUMMARY) appendFileSync(vars.GITHUB_STEP_SUMMARY, `${text}\n`);
  for (const line of shapeAnnotations(probe.results ?? [])) log(line);
  log(`::notice title=Траты v3::${spend.line}`);
  log(
    `::${summary.passed ? "notice" : "error"} title=V3 форма::Как в сборке прошли ${summary.prodOk} из ${summary.prodTotal} моделей, вариантов годны ${summary.ready} из ${summary.total}; ${Number.isFinite(exact) ? `${exact} ₽ по журналу` : `≈ ${summary.costRub} ₽`}${unrecorded > 0 ? ` + ≈ ${unrecorded} ₽ вне журнала` : ""}${probe.total?.stopped ? `; остановлена: ${probe.total.stopped}` : ""}`,
  );
  return summary.passed ? 0 : 1;
}

/**
 * V3-01: the spend section of a measurement report — «потрачено X ₽ из плана Y ₽ волны …» with this run added to its
 * wave in the journal, the run's pre-registration against its outcome, the platform's eval spend since the start of
 * the v3 budget (`v3Server` — collectSql) and the entry for the journal (spend.mjs register --entry).
 */
export function evalSpend({
  spend,
  journal,
  runid,
  summary,
  stopped = null,
  v3Server = null,
  now,
  verdict: own = null,
}) {
  const rub = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
  const actualRub = summary.costRub;
  const line = spendLine(journal, spend.wave, actualRub);
  const verdict =
    own ??
    `засчитано ${summary.ready} из ${summary.total}, порог ${summary.passed ? "пройден" : "не пройден"}`;
  const entry = {
    date: moscowDate(now()),
    ...spend,
    actualRub,
    result: stopped ? `остановлен: ${stopped}; ${verdict}` : verdict,
    runId: runid,
  };
  const text = [
    "## Траты v3",
    "",
    `- Итого: ${line}.`,
    `- Прогон \`${runid}\`, волна ${spend.wave}: цель — ${spend.purpose}; гипотеза — ${spend.hypothesis}. Ожидали ${rub(spend.expectRub)}, потолок ${rub(spend.capRub)}, факт ${rub(actualRub)} ${summary.costExact ? "(точно, по журналу вызовов моделей)" : "(оценка по кредитам)"}${actualRub > spend.expectRub ? " — дороже ожиданий" : ""}.`,
    ...(stopped ? [`- Прогон остановлен: ${stopped}.`] : []),
    ...(v3Server
      ? [
          `- По журналу вызовов моделей платформы пробы и замеры с ${v3Server.since} потратили ${rub(v3Server.rub)}.`,
        ]
      : []),
    "- Запись для журнала docs/progress/v3-spend.json (файл spend-entry.json рядом с отчётом): `node tools/deploy/spend.mjs register --entry spend-entry.json`",
    "",
    "```json",
    JSON.stringify(entry),
    "```",
    "",
  ].join("\n");
  return { line, entry, text };
}

const emailMark = (email) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

/** Non-secret next steps for the job summary (Russian, no addresses, no values). */
export function summaryText({ env, command, domains, tag, state }) {
  const url = `https://${domains.platform}`;
  const lines = [`## Пилот ${env}: ${command === "destroy" ? "удалён" : "готово"}`, ""];
  if (command === "destroy")
    return [...lines, "Окружение и его бакеты удалены. Ключи остаются в бакете состояния."].join("\n");
  lines.push(`- Платформа: ${url}/`, ...(tag ? [`- Версия: \`${tag}\``] : []), "");
  if (state.restored)
    lines.push(
      "**ВМ была пересоздана.** PostgreSQL поднят из архива WAL-G, том `.data` восстановлен из копии. Проверьте последние изменения клиентов.",
      "",
    );
  if (state.bundleCreated)
    lines.push(
      "- Ключи окружения созданы и зашифрованы паролем `WIZARD_STATE_PASSPHRASE`. Держите его в менеджере паролей: без него архив базы не расшифровать.",
    );
  if (state.staff === "pending")
    lines.push(
      `- Откройте ${url}/login и войдите с почтой из \`WIZARD_FOUNDER_EMAIL\`: код придёт письмом.`,
      `- Через минуту после первого входа учётка получит права staff. Откройте ${url}/admin и включите MFA (приложение-аутентификатор), коды восстановления сохраните.`,
    );
  else if (state.staff === "done") lines.push(`- Консоль модерации: ${url}/admin (вход с MFA).`);
  // diagnose and eval do not touch the founder access: nothing to say about it there.
  else if (command === "deploy" || command === "bootstrap")
    lines.push("- `WIZARD_FOUNDER_EMAIL` не задан: права staff не выдавались.");
  if (env === "staging")
    lines.push("- Staging оплачивается по часам: удалите его через bootstrap-pilot → destroy.");
  return lines.join("\n");
}

function mask(values, vars, log) {
  if (vars.GITHUB_ACTIONS !== "true") return;
  for (const v of values) if (v && String(v).length >= 6) log(`::add-mask::${v}`);
}

/**
 * B2-41: the stocks as the server sees them — Pexels answered 404 to the builds on the pilot while the runner's check
 * said 200. One search per provider and one picture per image host from the worker pod (the builds run there), with
 * the release keys of its env; prints `name=HTTP` only (never a key, a URL or a body).
 */
export const SERVER_STOCK_PROBE = `const t = async (n, u, h) => {
  try { const r = await fetch(u, { headers: h, redirect: "manual", signal: AbortSignal.timeout(15000) }); return n + "=" + r.status; }
  catch (e) { return n + "=0:" + String(e?.cause?.code ?? e?.name ?? "error").slice(0, 40); }
};
const e = process.env;
Promise.all([
  e.WIZARD_STOCK_PEXELS_KEY ? t("pexels", "https://api.pexels.com/v1/search?query=coffee&per_page=1", { authorization: e.WIZARD_STOCK_PEXELS_KEY }) : "pexels=missing",
  e.WIZARD_STOCK_PIXABAY_KEY ? t("pixabay", "https://pixabay.com/api/?key=" + encodeURIComponent(e.WIZARD_STOCK_PIXABAY_KEY) + "&q=coffee&per_page=3") : "pixabay=missing",
  t("images.pexels.com", "https://images.pexels.com/photos/302899/pexels-photo-302899.jpeg?auto=compress&w=40"),
  t("cdn.pixabay.com", "https://cdn.pixabay.com/photo/2015/10/12/14/54/coffee-983955_150.jpg"),
]).then((a) => console.log(a.join(" ")));`;

/** «pexels=404 pixabay=200 …» of SERVER_STOCK_PROBE → the annotation line; null when the output is not that. */
export function serverStockLine(out) {
  const pairs = String(out ?? "")
    .trim()
    .split(/\s+/)
    .map((p) => /^([a-z.]+)=([0-9a-zA-Z_:]+)$/.exec(p))
    .filter(Boolean);
  if (pairs.length === 0) return null;
  return pairs.map(([, n, v]) => `${n} — ${/^\d+$/.test(v) ? `HTTP ${v}` : v}`).join("; ");
}

/** Runs SERVER_STOCK_PROBE in the worker pod and logs one annotation (not fatal: the landings keep theme graphics). */
export function serverStockProbe({ kubectl, log = console.log }) {
  const r = kubectl(
    ["-n", PLATFORM_NS, "exec", "deploy/wizard-worker", "--", "node", "-e", SERVER_STOCK_PROBE],
    {
      capture: true,
      allowFail: true,
      fake: "pexels=200 pixabay=200 images.pexels.com=200 cdn.pixabay.com=200",
    },
  );
  const line = r.status === 0 ? serverStockLine(r.stdout) : null;
  log(
    line
      ? `::notice title=Стоки с сервера::${line}`
      : `::warning title=Стоки с сервера::проверка из пода воркера не удалась (код ${r.status})`,
  );
  return line;
}

/**
 * B2-43: what the photo library job of a release (pilot-reusable.yml stock-library, stock_mode=library) needs from it:
 * the systems' files bucket, its endpoint and region — the storage the platform pods get (clusterSecretFiles, helm
 * config.s3Endpoint, providers/timeweb.yaml s3Region). The job reads the S3 account key from the same secrets, so
 * without the account key (the pods then use the bucket keys of tofu) there is nothing to seed with. null — no seeding.
 */
export function stockLibraryOutputs({ vars, outputs, log = () => {} }) {
  if (pilotStockMode(vars) !== "library") return null;
  const title = "::warning title=Библиотека фото::";
  if (!vars.WIZARD_S3_ACCOUNT_KEY_ID || !vars.WIZARD_S3_ACCOUNT_SECRET) {
    log(
      `${title}нет ключа S3-аккаунта (секреты AWS_ACCESS_KEY_ID и AWS_SECRET_ACCESS_KEY) — библиотека не пополняется`,
    );
    return null;
  }
  const bucket = outputs?.env?.buckets?.files;
  if (!bucket) {
    log(`${title}в выходах tofu нет бакета files — библиотека не пополняется`);
    return null;
  }
  return { files_bucket: bucket, s3_endpoint: outputs.env.s3_endpoint || S3.endpoint, s3_region: S3.region };
}

/**
 * Stock keys of a release (B2-38): with stock_mode=live (record) each key is tried with one search; a refused key
 * turns its provider off for this release (it never reaches the platform Secret) with a warning — the release goes on,
 * as with the other optional services (Unisender, Z.ai): the landings keep the theme graphics. No answer keeps the
 * key (a runner's network hiccup is no verdict on it). Returns {mode, off, lines}: lines for the log and the summary
 * (verdicts and HTTP codes only — never a key or a URL).
 */
export async function stockKeysOfRelease(vars, { fetch: f = fetch, log = () => {} } = {}) {
  const mode = pilotStockMode(vars);
  if (mode === "library") {
    const lines = [
      "Фото на сайтах — из библиотеки фото платформы (stock_mode=library): ключи стоков в платформу не передаются, сервер стоки не вызывает.",
      "Библиотеку пополняет задание stock-library этого выката на раннере GitHub (там стоки доступны); его сбой — предупреждение, выкат не падает.",
    ];
    for (const l of lines) log(l);
    log(
      "::notice title=Фото со стоков::библиотека фото (stock_mode=library): ключи в платформу не передаются",
    );
    return { mode, off: [], lines };
  }
  if (!STOCK_KEY_MODES.includes(mode)) {
    const lines = [`Фото со стоков выключены (stock_mode=${mode}): ключи в платформу не передаются.`];
    for (const l of lines) log(l);
    log(`::notice title=Фото со стоков::выключены (stock_mode=${mode}): ключи не проверялись`);
    return { mode, off: [], lines };
  }
  const verdicts = await stockKeyVerdicts(vars, { fetch: f });
  const off = verdicts
    .filter((v) => v.verdict === "invalid" || v.verdict === "missing")
    .map((v) => v.provider);
  const lines = [`Фото со стоков (stock_mode=${mode}), проверка ключей:`];
  for (const v of verdicts) {
    const what =
      v.verdict === "invalid" || v.verdict === "missing"
        ? " — сток выключен в этом выкате"
        : v.verdict === "unchecked"
          ? " — ключ передан без проверки"
          : "";
    lines.push(`- ${stockVerdictLine(v)}${what}`);
  }
  for (const l of lines) log(l);
  log(stockAnnotation(verdicts));
  for (const v of verdicts) {
    const name = STOCK_KEY_ENV[v.provider][0];
    if (v.verdict === "invalid")
      log(
        `::warning title=pilot::${stockVerdictLine(v)}: замените ${name} в секретах GitHub, фото этого стока выключены`,
      );
    else if (v.verdict === "missing")
      log(`::warning title=pilot::${name} не задан: фото этого стока выключены`);
    else if (v.verdict === "unchecked")
      log(`::warning title=pilot::${stockVerdictLine(v)}: ключ передан в платформу без проверки`);
  }
  if (off.length === verdicts.length) {
    lines.push("- Ни одного рабочего ключа: на сайтах систем будет графика темы вместо фото.");
    log(
      "::warning title=pilot::Ни одного рабочего ключа стоков: на сайтах систем будет графика темы вместо фото",
    );
  }
  return { mode, off, lines };
}

/**
 * Read-only state probe of `check`: the state bucket (never created, never waited for) and, when the environment's keys
 * exist, whether WIZARD_STATE_PASSPHRASE decrypts them. Returns {status, detail}.
 */
export async function checkState(api, env, vars, { fetch: f = fetch, now, log = () => {} } = {}) {
  const state = await ensureStateBucket(api, { create: false, attempts: 0 });
  if (!state)
    return { status: "skipped", detail: `бакета ${STATE_BUCKET} ещё нет: его создаст первый apply` };
  mask([state.accessKeyId, state.secretAccessKey], vars, log);
  const resolved = await resolveStateS3(api, state, { fetch: f, now, log, vars });
  mask([resolved.accessKeyId, resolved.secretAccessKey], vars, log);
  const text = await getObjectOrNull(stateS3(resolved), bundleKey(env), { fetch: f, now });
  if (!text) return { status: "ok", detail: `бакет есть, ключей ${env} ещё нет: их создаст первый apply` };
  decryptBundle(text, vars.WIZARD_STATE_PASSPHRASE, env);
  return { status: "ok", detail: `пароль подходит к ключам ${env}` };
}

/**
 * Entry: returns the exit code. deps (tests): fetch, now, rand, sleep, log, run/has/exists (passed to infra.mjs),
 * infraMain, skipSmoke, kdf.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const o = parseArgs(argv);
  // V3-01: the wave plan of the spend journal is checked before anything else (no SSH, no account, no spend).
  const journal = PAID.includes(o.command) ? readJournal(deps.spendJournal ?? JOURNAL) : null;
  if (journal) o.spend = preregister(o.spend, journal);
  const target = o.command === "close-access" ? { vars: env, problems: [] } : envVars(o.env, env);
  const vars = target.vars;
  const log = deps.log ?? ((s) => console.log(s));
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const rand = deps.rand ?? randomBytes;
  // B2-38: the stock keys are never printed (GitHub masks its secrets too; this covers values passed otherwise).
  mask(
    Object.values(STOCK_KEY_ENV).map(([input]) => vars[input]),
    vars,
    log,
  );
  if (o.command === "check") {
    mask(
      SECRET_NAMES.map((n) => vars[n]),
      vars,
      log,
    );
    const api = twcClient({ token: vars.TWC_TOKEN, fetch: f });
    await reportServerOptions(api, SHAPES[o.env].server, { log });
    const { servers = [] } = await api("GET", "/api/v1/servers").catch(() => ({ servers: [] }));
    for (const s of servers) await reportServerHealth(api, s, { log, now });
    return runPreflight({
      env: o.env,
      vars,
      inputProblems: checkInputs("bootstrap", vars),
      stagingProblems: target.problems,
      stateProbe: () => checkState(api, o.env, vars, { fetch: f, now, log }),
      fetch: f,
      smtp: deps.smtp,
      log,
      summary: (text) => vars.GITHUB_STEP_SUMMARY && appendFileSync(vars.GITHUB_STEP_SUMMARY, text),
    });
  }
  const problems = [...target.problems, ...checkInputs(o.command, vars)];
  if (problems.length > 0) {
    const text = problems.map(([n, why]) => `  - ${n}: ${why}`).join("\n");
    log(
      `::error title=pilot::Не хватает настроек GitHub (docs/ops/deploy.md «Что нужно от основателя»):\n${text}`,
    );
    if (vars.GITHUB_STEP_SUMMARY)
      appendFileSync(vars.GITHUB_STEP_SUMMARY, `## Пилот: не хватает настроек\n\n${text}\n`);
    return 2;
  }
  const api = twcClient({ token: vars.TWC_TOKEN, fetch: f });
  if (o.command === "close-access") {
    await closeAdminAccess(api, o.env, { log });
    return 0;
  }

  const state = await ensureStateBucket(api, { create: o.command === "bootstrap", sleep: deps.sleep, log });
  if (!state) {
    log(`::error title=pilot::Нет бакета ${STATE_BUCKET}: сначала запустите bootstrap-pilot для ${o.env}.`);
    return 3;
  }
  mask([state.accessKeyId, state.secretAccessKey], vars, log);
  const resolved = await untilS3Ready(() => resolveStateS3(api, state, { fetch: f, now, log, vars }), {
    sleep: deps.sleep,
    log,
  });
  mask([resolved.accessKeyId, resolved.secretAccessKey], vars, log);
  const s3 = stateS3(resolved);
  const passphrase = vars.WIZARD_STATE_PASSPHRASE;
  log(`бакет состояния: ${resolved.bucket}${state.created ? " (создан сейчас)" : ""}`);
  const { bundle, existed } = await untilS3Ready(
    () =>
      loadBundle({
        s3,
        env: o.env,
        passphrase,
        create: o.command === "bootstrap",
        fetch: f,
        now,
        rand,
        kdf: deps.kdf,
        log,
      }),
    { sleep: deps.sleep, log },
  );
  mask(secretValues(bundle), vars, log);
  if (o.command === "show-secrets") {
    if (vars.GITHUB_ACTIONS === "true")
      throw new Error("show-secrets: только на компьютере основателя, не в CI");
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  }

  const work = join(vars.RUNNER_TEMP || deps.tmpRoot || tmpdir(), `wizard-pilot-${o.env}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const file = (name, text) => {
    const p = join(work, name);
    writeFileSync(p, text, { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  };
  const server = await resolvePilotServer(
    api,
    vars.WIZARD_PILOT_SERVER || bundle.server?.id,
    SHAPES[o.env].server,
  );
  if (server) {
    log(
      `сервер окружения: ${server.id} «${server.name}» ${server.location}, ${server.ip} (передан основателем)`,
    );
    if (bundle.server?.id !== server.id || bundle.server?.ip !== server.ip) {
      bundle.server = { id: server.id, ip: server.ip };
      await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf: deps.kdf });
    }
  }
  if (o.command === "reboot") {
    if (!server)
      throw new Error("reboot: у окружения нет переданного сервера (WIZARD_PILOT_SERVER или bootstrap)");
    await rebootServer(api, server, { log, sleep: deps.sleep });
    return 0;
  }
  const sshKey = file("id_ed25519", bundle.secrets.SSH_PRIVATE_KEY);
  const varFile = file(
    "pilot.tfvars.json",
    JSON.stringify(tfvars(o.env, vars, bundle.secrets.SSH_PUBLIC_KEY, server), null, 2),
  );
  const ivars = {
    ...vars,
    WIZARD_PROVIDER: "timeweb",
    WIZARD_TF_STATE_BUCKET: resolved.bucket,
    WIZARD_TF_STATE_ACCESS_KEY_ID: resolved.accessKeyId,
    WIZARD_TF_STATE_SECRET_ACCESS_KEY: resolved.secretAccessKey,
    WIZARD_TF_STATE_PASSPHRASE: passphrase,
    WIZARD_TFVARS_FILE: varFile,
    WIZARD_SSH_KEY_FILE: sshKey,
    WIZARD_K3S_ACCESS: "tunnel",
    WIZARD_ACME_EMAIL: vars.WIZARD_ACME_EMAIL || vars.WIZARD_FOUNDER_EMAIL || "",
    // First certificates over DNS-01 (TXT propagation + Let's Encrypt) may take more than 10 minutes: 40 × 30 s.
    WIZARD_SMOKE_ATTEMPTS: vars.WIZARD_SMOKE_ATTEMPTS || "40",
    // Never released yet → the database starts empty without asking the archive (it cannot hold anything).
    WIZARD_PG_FIRST_BOOT: bundle.deployedAt ? "" : "1",
    // SSH waits: a fresh VM installs k3s from cloud-init (40 × ~25 s); a server that has run a release only needs to
    // answer; diagnose looks at a running cluster.
    WIZARD_K3S_WAIT_ATTEMPTS: ["diagnose", "eval", "v3-probe"].includes(o.command)
      ? "4"
      : bundle.deployedAt
        ? "12"
        : "40",
    RUNNER_TEMP: work,
  };

  const st = { bundleCreated: !existed, fresh: false, restored: false, staff: "none", outputs: null };
  // B2-38: a release checks the stock keys before the platform Secret is written (refused keys stay out of it).
  let stockOff = [];
  if (o.command === "bootstrap" || o.command === "deploy") {
    const stock = await stockKeysOfRelease(vars, { fetch: f, log });
    stockOff = stock.off;
    if (vars.GITHUB_STEP_SUMMARY)
      appendFileSync(
        vars.GITHUB_STEP_SUMMARY,
        `## Пилот ${o.env}: фото со стоков\n\n${stock.lines.join("\n")}\n\n`,
      );
  }
  const founder = (vars.WIZARD_FOUNDER_EMAIL ?? "").trim().toLowerCase();
  const hooks = {
    beforeCluster: async (outputs) => {
      st.outputs = outputs;
      mask(
        Object.values(outputs.s3_keys ?? {}).flatMap((k) => [k?.access_key, k?.secret_key]),
        vars,
        log,
      );
      const files = clusterSecretFiles({ bundle, outputs, inputs: vars, stockOff });
      mkdirSync(join(work, "pgbouncer"), { recursive: true, mode: 0o700 });
      const extra = {
        WIZARD_PLATFORM_ENV_FILE: file("platform.env", files.platformEnv),
        WIZARD_POSTGRES_ENV_FILE: file("postgres.env", files.postgresEnv),
        WIZARD_DNS_SOLVER_ENV_FILE: file("dns-solver.env", files.dnsSolverEnv),
        WIZARD_PGBOUNCER_SECRET_DIR: join(work, "pgbouncer"),
      };
      file(join("pgbouncer", "userlist.txt"), files.userlist);
      const ip = await runnerIp(f);
      await openAdminAccess(api, o.env, ip, { runId: vars.GITHUB_RUN_ID, log });
      return { vars: extra, close: () => closeAdminAccess(api, o.env, { log }) };
    },
    afterKubeconfig: async ({ kubectl }) => {
      // A listing, not a `get` of one namespace: an unreachable API must fail here, never read as "fresh cluster"
      // (that would restore .data over live files).
      const names = String(kubectl(["get", "namespaces", "-o", "name"], { capture: true }).stdout ?? "");
      if (!names.includes("namespace/")) throw new Error("kubectl: пустой список пространств имён");
      st.fresh = !names.split(/\s+/).includes(`namespace/${PLATFORM_NS}`);
      if (st.fresh)
        log(st.bundleCreated ? "кластер новый: первый выкат" : "кластер пустой при существующих ключах");
      if (!st.fresh) releaseStuckChallenges({ kubectl, log, now });
    },
    afterRelease: async ({ kubectl, outputs, tag }) => {
      let changed = false;
      // DNS before the smoke: records that are not ours (a parked A on the root, a duplicate SPF) would send part of
      // the checks elsewhere (6th live bootstrap, 2026-10-03: the root still had the founder's other VM).
      if (o.command === "bootstrap") {
        await ensureDmarc(api, vars.WIZARD_SYSTEMS_DOMAIN, { log });
        await ensureDnsRecords(api, vars.WIZARD_PLATFORM_DOMAIN, platformDnsRecords(), { log });
        await tidyDns(api, {
          zones: [vars.WIZARD_PLATFORM_DOMAIN, vars.WIZARD_SYSTEMS_DOMAIN],
          ingressIp: outputs.env?.ingress_ip,
          ourSpf: {
            [vars.WIZARD_SYSTEMS_DOMAIN]: "v=spf1 -all",
            ...(vars.WIZARD_PLATFORM_MAIL_SPF
              ? { [vars.WIZARD_PLATFORM_DOMAIN]: `v=spf1 ${vars.WIZARD_PLATFORM_MAIL_SPF} -all` }
              : {}),
          },
          dkimSelector: vars.WIZARD_PLATFORM_DKIM_SELECTOR || "",
          log,
        });
      }
      // Every release (deploy too): the sender domain stays confirmed at Unisender — login codes depend on it.
      if (o.command === "bootstrap" || o.command === "deploy")
        await ensureUnisenderDomain(api, { vars, fetch: f, log }).catch((e) =>
          log(`::warning title=pilot::Unisender: домен отправителя не проверен (${e.message})`),
        );
      // The sandbox of client functions (M2-18): one gVisor pod of this release's workerd image.
      if (outputs.env?.registry_url)
        gvisorProbe({ kubectl, image: `${outputs.env.registry_url}/wizard-sandbox:${tag}`, log });
      // B2-41: the stocks from the server itself (the builds' network), with the keys of this release.
      if (STOCK_KEY_MODES.includes(pilotStockMode(vars))) serverStockProbe({ kubectl, log });
      // B2-43: the photo library job of this release seeds the same files bucket (step outputs, never a key).
      const library =
        o.command === "bootstrap" || o.command === "deploy"
          ? stockLibraryOutputs({ vars, outputs, log })
          : null;
      if (library && vars.GITHUB_OUTPUT)
        appendFileSync(
          vars.GITHUB_OUTPUT,
          Object.entries(library)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(""),
        );
      // WAL-G against the archive from the running database (not fatal: archiving lag is alerted by pg-ops anyway).
      checkArchive({ kubectl, log, bucket: outputs.env?.buckets?.backups ?? "" });
      // Lost VM: PostgreSQL has restored itself from WAL-G (init container); bring .data back from its copy.
      if (st.fresh && bundle.deployedAt) {
        const job = `wizard-data-restore-${Math.floor(now().getTime() / 1000)}`;
        log("ВМ пересоздана: восстанавливаю .data из копии в бакете backups");
        kubectl(["-n", PLATFORM_NS, "create", "job", `--from=cronjob/wizard-data-restore`, job]);
        kubectl(["-n", PLATFORM_NS, "wait", "--for=condition=complete", `job/${job}`, "--timeout=30m"]);
        kubectl(["-n", PLATFORM_NS, "rollout", "restart", "deployment"]);
        st.restored = true;
      }
      if (founder) {
        const mark = emailMark(founder);
        if (bundle.founderStaff === mark) st.staff = "done";
        else {
          const r = kubectl(
            ["-n", PLATFORM_NS, "get", "job", FOUNDER_JOB, "-o", "jsonpath={.status.succeeded}"],
            { capture: true, allowFail: true },
          );
          if (r.status === 0 && String(r.stdout).trim() === "1") {
            bundle.founderStaff = mark;
            changed = true;
            st.staff = "done";
          } else {
            kubectl(["-n", PLATFORM_NS, "delete", "job", FOUNDER_JOB, "--ignore-not-found"]);
            const image = `${outputs.env.registry_url}/wizard-postgres:${tag}`;
            kubectl(["apply", "-f", "-"], {
              input: JSON.stringify(founderStaffJob({ image, email: founder })),
            });
            st.staff = "pending";
          }
        }
      }
      if (!bundle.deployedAt) {
        bundle.deployedAt = now().toISOString();
        changed = true;
      }
      if (changed) await saveBundle({ s3, bundle, passphrase, fetch: f, now, rand, kdf: deps.kdf });
    },
  };

  // The cluster part of eval and v3-probe runs under the access of diagnose: SSH for this runner only, the tunnel, closed.
  const inCluster = (onCluster) =>
    (deps.infraMain ?? infraMain)(["diagnose", "--env", o.env, "--yes"], ivars, {
      log,
      hooks: { beforeCluster: hooks.beforeCluster, onCluster },
      run: deps.run,
      has: deps.has,
      exists: deps.exists,
      sleep: deps.sleep,
      fetch: deps.fetch,
    });
  if (o.command === "v3-probe" && o.shape)
    return pilotV3Shape({
      o,
      vars,
      journal,
      log,
      now,
      rand,
      outDir: join(vars.RUNNER_TEMP || deps.tmpRoot || tmpdir(), `wizard-eval-${o.env}`),
      inCluster,
      fake: deps.probeFake === true,
      fakeFail: deps.probeShapeFail ?? [],
    });
  if (o.command === "v3-probe")
    return pilotV3Probe({
      o,
      vars,
      journal,
      log,
      now,
      rand,
      outDir: join(vars.RUNNER_TEMP || deps.tmpRoot || tmpdir(), `wizard-eval-${o.env}`),
      inCluster,
      fake: deps.probeFake === true,
    });
  if (o.command === "eval")
    return pilotEval({
      o,
      vars,
      journal,
      log,
      fetch: f,
      now,
      rand,
      sleep: deps.sleep,
      pollMs: deps.evalPollMs,
      maxBriefRub: deps.evalMaxBriefRub,
      ...(deps.evalScreenshots ? { screenshots: deps.evalScreenshots } : {}),
      ...(deps.v3Eval ? { v3Eval: deps.v3Eval } : {}),
      outDir: join(vars.RUNNER_TEMP || deps.tmpRoot || tmpdir(), `wizard-eval-${o.env}`),
      inCluster,
    });
  const command = { bootstrap: "apply", deploy: "deploy", destroy: "destroy", diagnose: "diagnose" }[
    o.command
  ];
  if (o.command === "diagnose")
    await reportDns(api, [vars.WIZARD_PLATFORM_DOMAIN, vars.WIZARD_SYSTEMS_DOMAIN], { log });
  const args = [command, "--env", o.env, "--yes", ...(o.tag ? ["--tag", o.tag] : [])];
  const runInfra = () =>
    (deps.infraMain ?? infraMain)(args, ivars, {
      log,
      hooks,
      run: deps.run,
      has: deps.has,
      exists: deps.exists,
      sleep: deps.sleep,
      fetch: deps.fetch,
      skipSmoke: deps.skipSmoke,
      skipImageWait: deps.skipImageWait,
    });
  // Bootstrap only: when Timeweb has no capacity at the requested place, the next RF place is tried with the same
  // preset ceiling (OpenTofu replaces the floating IP and the VPC; nothing is paid twice).
  const places = o.command === "bootstrap" && !server ? placesFrom(vars) : [null];
  let code;
  for (let i = 0; ; i++) {
    try {
      code = await runInfra();
      break;
    } catch (e) {
      const next = places[i + 1];
      if (!next || !CAPACITY_ERROR.test(e?.output ?? "")) throw e;
      log(
        `::warning title=pilot::Timeweb: нет мощностей в ${places[i].location}${places[i].zone ? `/${places[i].zone}` : ""} — пробую ${next.location}${next.zone ? `/${next.zone}` : ""}`,
      );
      file(
        "pilot.tfvars.json",
        JSON.stringify(
          tfvars(
            o.env,
            { ...vars, WIZARD_TIMEWEB_LOCATION: next.location, WIZARD_TIMEWEB_ZONE: next.zone },
            bundle.secrets.SSH_PUBLIC_KEY,
          ),
          null,
          2,
        ),
      );
    }
  }
  if (code === 0) {
    const text = summaryText({
      env: o.env,
      command: o.command,
      domains: { platform: vars.WIZARD_PLATFORM_DOMAIN },
      tag: o.tag,
      state: st,
    });
    log(text);
    if (vars.GITHUB_STEP_SUMMARY) appendFileSync(vars.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error title=pilot::${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
