// Read-only preflight of the pilot's founder inputs (`node tools/deploy/pilot.mjs check`, bootstrap-pilot action
// `check`; docs/ops/deploy.md «Пилот: одна кнопка», docs/reviews/impl-notes/pilot-preflight.md). Every probe is a
// cheap authenticated read (the Unisender Go key check is a POST to system/ping, which sends nothing): it creates
// nothing, changes nothing and spends no model tokens. The only side effect is one Telegram message to the alert
// chat — that is the probe. Output names settings, never their values: every line and the step summary pass through
// `scrub`, which replaces any secret value that slipped into a message.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Default base URLs of packages/llm/src/registry.ts PROVIDERS (a test keeps them equal). */
export const DEFAULT_BASE = {
  cloudru: "https://foundation-models.api.cloud.ru/v1",
  zai: "https://api.z.ai/api/paas/v4",
};
export const TWC_API = "https://api.timeweb.cloud";
export const TELEGRAM_API = "https://api.telegram.org";
export const ALERT_TEXT = "Wizard: проверка настроек пилота — алерты доходят";
const TIMEOUT_MS = 15_000;

/** Founder inputs that are GitHub secrets: their values never reach a log line or the summary. */
export const SECRET_NAMES = [
  "TWC_TOKEN",
  "WIZARD_STATE_PASSPHRASE",
  "CLOUDRU_API_KEY",
  "ZAI_API_KEY",
  "WIZARD_SMTP_HOST",
  "WIZARD_SMTP_USER",
  "WIZARD_SMTP_PASSWORD",
  "WIZARD_SMTP_FROM",
  "WIZARD_OPS_ALERT_TELEGRAM_TOKEN",
  "WIZARD_OPS_ALERT_CHAT_ID",
  "WIZARD_OPS_ALERT_URL",
  "WIZARD_GHCR_TOKEN",
  "WIZARD_GHCR_JOB_TOKEN",
  "WIZARD_S3_ACCOUNT_KEY_ID",
  "WIZARD_S3_ACCOUNT_SECRET",
  // B2-38: stock photo keys (GitHub secrets of the same name).
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
];

export const STATUS_TEXT = { ok: "ok", fail: "ошибка", skipped: "пропущено" };

const TG_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const SPF_TERM =
  /^[+?~-]?(include:[^\s:]+\.[^\s:]+|a(:[^\s]+)?(\/\d{1,3})?|mx(:[^\s]+)?(\/\d{1,3})?|ip4:[0-9./]+|ip6:[0-9a-fA-F:./]+|exists:[^\s]+)$/i;

/** Replaces every secret value (≥ 6 characters, longest first) in a text with ***. */
export function scrubber(vars) {
  const values = SECRET_NAMES.map((n) => String(vars[n] ?? ""))
    .filter((v) => v.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((t, v) => t.split(v).join("***"), String(text));
}

const row = (title, status, detail, { required = true, warnings = [] } = {}) => ({
  title,
  status,
  detail,
  required,
  warnings,
});

/** GET/POST with a timeout; {status, json} or {status: 0, error: "<errno>"} — never the URL (it may carry a token). */
async function call(f, url, { method = "GET", headers = {}, body } = {}) {
  try {
    const r = await f(url, {
      method,
      headers: {
        accept: "application/json",
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, json };
  } catch (e) {
    const code = e?.cause?.code ?? (e?.name === "TimeoutError" ? "таймаут" : "сеть");
    return { status: 0, error: String(code).replace(/[^\w-]/g, "") || "сеть" };
  }
}

const noAnswer = (r) => `нет ответа (${r.error})`;

/** «Wizard <noreply@domain>» or a bare address → {address, domain} (apps/platform-api config.ts parseMailFrom). */
export function parseFrom(v) {
  const s = String(v ?? "").trim();
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  const address = m ? m[2] : s;
  if (!EMAIL.test(address)) return null;
  return { address, domain: address.split("@")[1].toLowerCase() };
}

/** WIZARD_PLATFORM_MAIL_SPF: mechanisms after `v=spf1` and before `-all` (the tofu module adds both). */
export function checkSpf(v) {
  const terms = String(v).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return "пусто";
  if (terms.some((t) => /^v=spf1$/i.test(t))) return "уберите «v=spf1»: выкат добавит его сам";
  if (terms.some((t) => /^[+?~-]?all$/i.test(t))) return "уберите «-all»/«~all»: выкат добавит «-all» сам";
  const bad = terms.filter((t) => !SPF_TERM.test(t));
  if (bad.length > 0)
    return `не похоже на механизмы SPF (нужно вида «include:…»), непонятных частей: ${bad.length}`;
  return null;
}

// ---- Timeweb Cloud ----

const BAD_DOMAIN_STATUS = {
  expired: "срок регистрации истёк",
  final_expired: "срок регистрации истёк окончательно",
  today_expired: "срок регистрации истекает сегодня",
  no_paid: "не оплачен",
  awaiting_payment: "ждёт оплаты",
  free: "не зарегистрирован",
};

/** Account: GET /api/v1/account/finances (balance) and /status (blocked). */
export async function probeTimeweb(vars, { fetch: f = fetch, base = TWC_API } = {}) {
  const title = "Timeweb Cloud: токен и баланс";
  if (!vars.TWC_TOKEN) return row(title, "skipped", "TWC_TOKEN не задан");
  const headers = { authorization: `Bearer ${vars.TWC_TOKEN}` };
  const fin = await call(f, `${base}/api/v1/account/finances`, { headers });
  if (fin.status === 0) return row(title, "fail", noAnswer(fin));
  if (fin.status === 401 || fin.status === 403)
    return row(
      title,
      "fail",
      `TWC_TOKEN отклонён (HTTP ${fin.status}): создайте токен заново в «API и Terraform»`,
    );
  if (fin.status !== 200) return row(title, "fail", `HTTP ${fin.status} на запрос баланса`);
  const warnings = [];
  const st = await call(f, `${base}/api/v1/account/status`, { headers });
  if (st.status === 200 && st.json?.status?.is_blocked)
    return row(title, "fail", "аккаунт Timeweb Cloud заблокирован");
  const { balance, currency, hours_left: hours } = fin.json?.finances ?? {};
  let detail = "токен принят";
  if (typeof balance === "number") {
    detail += `, баланс ${balance} ${currency ?? ""}`.trimEnd();
    if (typeof hours === "number") detail += `, хватит примерно на ${hours} ч`;
    if (balance <= 0) warnings.push("баланс Timeweb Cloud не положительный: пополните его до запуска apply");
  }
  return row(title, "ok", detail, { warnings });
}

/**
 * The domain as a DNS zone of the account — what infra/tofu/timeweb/modules/env/data.tf `twc_dns_zone` looks up by
 * name: GET /api/v1/domains/{fqdn}. A subdomain is accepted when its parent zone lists it.
 */
export async function probeDomain(
  vars,
  name,
  label,
  { fetch: f = fetch, base = TWC_API, shown = name } = {},
) {
  const title = `Timeweb Cloud: ${label} (${shown})`;
  const fqdn = vars[name];
  if (!fqdn) return row(title, "skipped", `${shown} не задан`);
  const headers = { authorization: `Bearer ${vars.TWC_TOKEN}` };
  const get = (d) => call(f, `${base}/api/v1/domains/${encodeURIComponent(d)}`, { headers });
  const r = await get(fqdn);
  if (r.status === 0) return row(title, "fail", noAnswer(r));
  const warnings = [];
  if (r.status === 200) {
    const why = BAD_DOMAIN_STATUS[r.json?.domain?.domain_status];
    if (why) warnings.push(`${name}: домен ${why} — проверьте в «Доменах» Timeweb Cloud`);
    return row(title, "ok", `${fqdn}: зона DNS есть в аккаунте`, { warnings });
  }
  if (r.status === 404) {
    const parent = fqdn.split(".").slice(1).join(".");
    if (parent.includes(".")) {
      const p = await get(parent);
      const subs = p.json?.domain?.subdomains ?? [];
      if (p.status === 200 && subs.some((s) => String(s?.fqdn ?? s).toLowerCase() === fqdn))
        return row(title, "ok", `${fqdn}: поддомен ${parent} в аккаунте`);
    }
    return row(
      title,
      "fail",
      `${fqdn} нет в «Доменах» аккаунта Timeweb Cloud: добавьте домен (или делегируйте его на NS Timeweb) — без зоны выкат не создаст записи DNS`,
    );
  }
  return row(title, "fail", `HTTP ${r.status} на запрос домена`);
}

// ---- Models ----

/** Cloud.ru Foundation Models: GET {base}/models (OpenAI-compatible list, no tokens spent). */
export async function probeCloudru(vars, { fetch: f = fetch } = {}) {
  const title = "Cloud.ru Foundation Models";
  if (!vars.CLOUDRU_API_KEY) return row(title, "skipped", "CLOUDRU_API_KEY не задан");
  const base = (vars.CLOUDRU_BASE_URL || DEFAULT_BASE.cloudru).replace(/\/+$/, "");
  const r = await call(f, `${base}/models`, { headers: { authorization: `Bearer ${vars.CLOUDRU_API_KEY}` } });
  if (r.status === 0) return row(title, "fail", noAnswer(r));
  if (r.status === 401 || r.status === 403)
    return row(
      title,
      "fail",
      `CLOUDRU_API_KEY отклонён (HTTP ${r.status}): нужен ключ сервиса Foundation Models`,
    );
  if (r.status !== 200) return row(title, "fail", `HTTP ${r.status} на список моделей`);
  const n = Array.isArray(r.json?.data) ? r.json.data.length : null;
  return row(title, "ok", `ключ принят${n === null ? "" : `, моделей доступно: ${n}`}`);
}

/**
 * Z.ai (optional): the API has no free model list or balance method (docs.z.ai/api-reference), so the probe asks for
 * the result of a task that does not exist (GET /async-result/{id}) — authenticated, no tokens. 401 with codes
 * 1000–1005 means a bad key; 429 with 1113/1309/1314/1316/1317 — no balance; a JSON 200/400/404 — the key passed
 * authentication; anything else is reported «не проверено».
 */
export async function probeZai(vars, { fetch: f = fetch } = {}) {
  const title = "Z.ai (необязательно)";
  const opt = { required: false };
  if (!vars.ZAI_API_KEY)
    return row(title, "skipped", "ZAI_API_KEY не задан: сборка пойдёт на модели Cloud.ru", opt);
  const base = (vars.ZAI_BASE_URL || DEFAULT_BASE.zai).replace(/\/+$/, "");
  const r = await call(f, `${base}/async-result/wizard-preflight-0`, {
    headers: { authorization: `Bearer ${vars.ZAI_API_KEY}` },
  });
  const code = Number(r.json?.error?.code ?? r.json?.code);
  if (r.status === 401) return row(title, "fail", `ZAI_API_KEY отклонён (HTTP 401, код ${code || "—"})`, opt);
  if (r.status === 429 && [1113, 1309, 1314, 1316, 1317].includes(code))
    return row(title, "fail", `ключ принят, но баланс Z.ai исчерпан (код ${code}): пополните`, opt);
  // A JSON answer past authentication (the API's own error object, not a proxy page) means the key was accepted.
  if ([200, 400, 404].includes(r.status) && r.json !== null)
    return row(title, "ok", "ключ принят (баланс не проверяется: у Z.ai нет бесплатного метода)", opt);
  return row(
    title,
    "skipped",
    `не проверено: ${r.status === 0 ? noAnswer(r) : `HTTP ${r.status}`}; бесплатного метода проверки у Z.ai нет`,
    opt,
  );
}

// ---- Stock photos (B2-38) ----

/** GitHub secrets of the stock keys by provider (pilot-reusable.yml passes them to the job under the same names). */
export const STOCK_KEY_INPUTS = { pexels: "PEXELS_API_KEY", pixabay: "PIXABAY_API_KEY" };
const STOCK_LABEL = { pexels: "Pexels", pixabay: "Pixabay" };
/** Russian names of the verdicts (job summary, log). */
export const STOCK_VERDICT_TEXT = {
  valid: "действителен",
  invalid: "недействителен",
  missing: "нет ключа",
  unchecked: "не проверен",
};

/**
 * One free search per provider (no quota is spent beyond one request): Pexels — GET /v1/search with the key in the
 * Authorization header; Pixabay — GET /api/?key=… (the key is in the URL: `call` never logs or returns the URL).
 * Returns {provider, verdict: valid | invalid | missing | unchecked, http} — 0 when there was no answer. 429 (rate
 * limit) counts as valid: the key was recognised. Pixabay answers 400 «Invalid or missing API key» for a bad key.
 */
export async function stockKeyVerdict(provider, key, { fetch: f = fetch } = {}) {
  const k = String(key ?? "").trim();
  if (!k) return { provider, verdict: "missing", http: 0 };
  const r =
    provider === "pexels"
      ? await call(f, "https://api.pexels.com/v1/search?query=coffee&per_page=1", {
          headers: { authorization: k },
        })
      : await call(f, `https://pixabay.com/api/?key=${encodeURIComponent(k)}&q=coffee&per_page=3`);
  const list = provider === "pexels" ? r.json?.photos : r.json?.hits;
  const bad = provider === "pexels" ? [401, 403] : [400, 401, 403];
  let verdict = "unchecked";
  if ((r.status === 200 && Array.isArray(list)) || r.status === 429) verdict = "valid";
  else if (bad.includes(r.status)) verdict = "invalid";
  return { provider, verdict, http: r.status, ...(r.status === 0 ? { error: r.error } : {}) };
}

/** Both providers, in the order of STOCK_KEY_INPUTS. */
export function stockKeyVerdicts(vars, { fetch: f = fetch } = {}) {
  return Promise.all(
    Object.entries(STOCK_KEY_INPUTS).map(([p, name]) => stockKeyVerdict(p, vars[name], { fetch: f })),
  );
}

/** «Pexels: действителен (HTTP 200)» — the verdict without the key or the URL. */
export function stockVerdictLine(v) {
  const how =
    v.verdict === "missing" ? "" : v.http ? ` (HTTP ${v.http})` : ` (нет ответа: ${v.error ?? "сеть"})`;
  return `${STOCK_LABEL[v.provider]}: ${STOCK_VERDICT_TEXT[v.verdict]}${how}`;
}

/** Rows of `check` (optional): the photos of the systems work without the stocks (theme graphics). */
export async function probeStock(vars, { fetch: f = fetch } = {}) {
  const mode = String(vars.WIZARD_STOCK_MODE || "off")
    .trim()
    .toLowerCase();
  const note = ["live", "record"].includes(mode) ? "" : `; сейчас stock_mode=${mode}: ключ не используется`;
  const opt = { required: false };
  return (await stockKeyVerdicts(vars, { fetch: f })).map((v) => {
    const title = `Фото: ключ ${STOCK_LABEL[v.provider]} (необязательно)`;
    const name = STOCK_KEY_INPUTS[v.provider];
    if (v.verdict === "missing")
      return row(title, "skipped", `${name} не задан: без него фото этого стока не подбираются${note}`, opt);
    const status = v.verdict === "valid" ? "ok" : v.verdict === "invalid" ? "fail" : "skipped";
    const hint = v.verdict === "invalid" ? `: замените ${name} в секретах GitHub` : "";
    return row(title, status, `${stockVerdictLine(v)}${hint}${note}`, opt);
  });
}

// ---- Mail ----

/** Plain TCP connection (the injectable SMTP connector). */
export function tcpConnect({ host, port, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

class SmtpStep extends Error {
  constructor(code, phase) {
    super(`${phase}${code ? ` ${code}` : ""}`);
    this.code = code;
    this.phase = phase;
  }
}

/** SMTP replies over a socket that can be swapped for TLS (packages/connectors/src/smtp.ts, auth only). */
class Conversation {
  constructor(socket) {
    this.buf = "";
    this.pending = [];
    this.replies = [];
    this.waiter = null;
    this.failed = null;
    this.attach(socket);
  }

  attach(s) {
    this.socket = s;
    s.on("data", (c) => this.onData(c.toString()));
    s.on("error", (e) => this.fail(e));
    s.on("close", () => this.fail(new Error("closed")));
  }

  fail(e) {
    if (this.failed) return;
    this.failed = e;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  onData(chunk) {
    this.buf += chunk;
    for (let i = this.buf.indexOf("\r\n"); i >= 0; i = this.buf.indexOf("\r\n")) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.pending.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.pending };
        this.pending = [];
        const w = this.waiter;
        this.waiter = null;
        if (w) w.resolve(reply);
        else this.replies.push(reply);
      }
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      const q = this.replies.shift();
      if (q) return resolve(q);
      if (this.failed) return reject(this.failed);
      this.waiter = { resolve, reject };
    });
  }

  async cmd(line, phase, expect) {
    if (line !== null) this.socket.write(`${line}\r\n`);
    let r;
    try {
      r = await this.read();
    } catch {
      throw new SmtpStep(0, phase);
    }
    if (!expect.includes(r.code)) throw new SmtpStep(r.code, phase);
    return r;
  }

  async upgrade(servername, ca) {
    const plain = this.socket;
    for (const ev of ["data", "error", "close"]) plain.removeAllListeners(ev);
    // Plaintext read before the handshake is dropped (STARTTLS injection).
    this.buf = "";
    this.pending = [];
    this.replies = [];
    const secure = await new Promise((resolve, reject) => {
      const t = tlsConnect({ socket: plain, servername, ca, minVersion: "TLSv1.2" }, () => resolve(t));
      t.once("error", reject);
    }).catch(() => {
      throw new SmtpStep(0, "tls");
    });
    this.attach(secure);
  }

  close() {
    this.socket.destroy();
  }
}

/** TLS mode as platform-api config.ts: WIZARD_SMTP_TLS, else implicit on 465 and STARTTLS otherwise. */
export function smtpEndpoint(vars) {
  const port = Number(vars.WIZARD_SMTP_PORT || 465);
  const t = String(vars.WIZARD_SMTP_TLS ?? "")
    .trim()
    .toLowerCase();
  const tls = ["implicit", "starttls", "none"].includes(t) ? t : port === 465 ? "implicit" : "starttls";
  return { host: String(vars.WIZARD_SMTP_HOST ?? "").trim(), port, tls };
}

const SMTP_PHASE = {
  connect: "нет соединения с WIZARD_SMTP_HOST:WIZARD_SMTP_PORT",
  tls: "TLS не установлен (порт 465 — неявный TLS, 587 — STARTTLS; проверьте хост и порт)",
  greeting: "сервер не поприветствовал (нужен код 220)",
  ehlo: "сервер отклонил EHLO",
  starttls: "сервер не предлагает STARTTLS на этом порту",
  auth: "вход не выполнен",
};

/** Connect, EHLO, STARTTLS when needed, AUTH (PLAIN or LOGIN) expecting 235, QUIT. Never MAIL FROM. */
export async function probeSmtp(
  vars,
  { connect = tcpConnect, ca, timeoutMs = TIMEOUT_MS, ehloName = "wizard-preflight.local" } = {},
) {
  const title = "Почта: SMTP-вход";
  const ep = smtpEndpoint(vars);
  if (!ep.host) return row(title, "skipped", "WIZARD_SMTP_HOST не задан");
  if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535)
    return row(title, "fail", "WIZARD_SMTP_PORT: нужен номер порта");
  const user = vars.WIZARD_SMTP_USER || "";
  if (user && ep.tls === "none")
    return row(
      title,
      "fail",
      "WIZARD_SMTP_TLS=none: пароль без TLS не отправляется — уберите эту переменную",
    );
  let socket;
  try {
    socket = await connect({ host: ep.host, port: ep.port, timeoutMs });
  } catch {
    return row(title, "fail", SMTP_PHASE.connect);
  }
  const conv = new Conversation(socket);
  const timer = setTimeout(() => conv.close(), timeoutMs);
  const mode = { implicit: "TLS", starttls: "STARTTLS", none: "без TLS" }[ep.tls];
  try {
    if (ep.tls === "implicit") await conv.upgrade(ep.host, ca);
    await conv.cmd(null, "greeting", [220]);
    const ehlo = `EHLO ${ehloName}`;
    let caps = await conv.cmd(ehlo, "ehlo", [250]);
    if (ep.tls === "starttls") {
      if (!caps.lines.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new SmtpStep(0, "starttls");
      await conv.cmd("STARTTLS", "starttls", [220]);
      await conv.upgrade(ep.host, ca);
      caps = await conv.cmd(ehlo, "ehlo", [250]);
    }
    const warnings = [];
    if (user) {
      const pass = vars.WIZARD_SMTP_PASSWORD || "";
      const auth = caps.lines.find((l) => /^250[ -]AUTH\b/i.test(l))?.toUpperCase() ?? "";
      if (/\bPLAIN\b/.test(auth)) {
        await conv.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, "auth", [235]);
      } else {
        await conv.cmd("AUTH LOGIN", "auth", [334]);
        await conv.cmd(Buffer.from(user).toString("base64"), "auth", [334]);
        await conv.cmd(Buffer.from(pass).toString("base64"), "auth", [235]);
      }
    } else warnings.push("WIZARD_SMTP_USER не задан: вход на SMTP-сервер не проверялся");
    await conv.cmd("QUIT", "quit", [221]).catch(() => undefined);
    return row(
      title,
      "ok",
      `${mode}, порт ${ep.port}: ${user ? "логин и пароль приняты (235)" : "сервер отвечает"}`,
      {
        warnings,
      },
    );
  } catch (e) {
    const phase = e instanceof SmtpStep ? e.phase : "connect";
    const code = e instanceof SmtpStep ? e.code : 0;
    if (phase === "auth" && code === 535)
      return row(title, "fail", "WIZARD_SMTP_USER или WIZARD_SMTP_PASSWORD не подошли (535)");
    const base = SMTP_PHASE[phase] ?? `ошибка на шаге ${phase}`;
    return row(title, "fail", `${base}${code ? ` (код ${code})` : ""}; режим ${mode}, порт ${ep.port}`);
  } finally {
    clearTimeout(timer);
    conv.close();
  }
}

/**
 * Platform mail transport as packages/connectors/src/mail-api.ts mailTransportOf (a test keeps them equal):
 * WIZARD_MAIL_TRANSPORT, else unisender-api for a *.unisender.ru SMTP host, else smtp; null — unknown value.
 */
export function mailTransport(vars) {
  const v = String(vars.WIZARD_MAIL_TRANSPORT ?? "")
    .trim()
    .toLowerCase();
  if (v) return ["smtp", "unisender-api"].includes(v) ? v : null;
  return /(^|\.)unisender\.ru$/i.test(
    String(vars.WIZARD_SMTP_HOST ?? "")
      .trim()
      .replace(/\.$/, ""),
  )
    ? "unisender-api"
    : "smtp";
}

/** Unisender Go API origin as mail-api.ts unisenderApiBase: WIZARD_MAIL_API_BASE, smtp.goN → goN, else goapi. */
export function mailApiBase(vars) {
  const o = String(vars.WIZARD_MAIL_API_BASE ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (o) return o;
  const m = /^smtp\.(go\d+)\.unisender\.ru\.?$/i.exec(String(vars.WIZARD_SMTP_HOST ?? "").trim());
  return m ? `https://${m[1].toLowerCase()}.unisender.ru` : "https://goapi.unisender.ru";
}

/**
 * The Unisender Go key (WIZARD_SMTP_PASSWORD) against POST system/ping.json on 443 — it checks the key and sends no
 * letter. Used instead of the SMTP login when platform mail goes over the HTTP API (the server's mail ports are closed).
 */
export async function probeMailApi(vars, { fetch: f = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const title = "Почта: ключ API Unisender Go";
  const key = vars.WIZARD_SMTP_PASSWORD || "";
  if (!key)
    return row(title, "fail", "WIZARD_SMTP_PASSWORD не задан: для отправки через API это ключ Unisender Go");
  const base = mailApiBase(vars);
  if (!base.startsWith("https://")) return row(title, "fail", "WIZARD_MAIL_API_BASE: нужен https-адрес");
  const host = new URL(base).host;
  let res;
  try {
    res = await f(`${base}/ru/transactional/api/v1/system/ping.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": key },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return row(title, "fail", `нет ответа от ${host} (порт 443)`);
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body?.status === "success")
    return row(title, "ok", `${host}: ключ принят (system/ping), письмо не отправлялось`);
  if (res.status === 401 || res.status === 403)
    return row(
      title,
      "fail",
      `${host} не принял WIZARD_SMTP_PASSWORD как API-ключ (HTTP ${res.status}); проверьте, что сервер (go1 или go2) тот же, что в адресе кабинета`,
    );
  return row(
    title,
    "fail",
    `${host} ответил HTTP ${res.status}${typeof body?.code === "number" ? `, код ${body.code}` : ""}`,
  );
}

/** Mail login row by transport: the Unisender Go API key or the SMTP login. */
export function probeMail(vars, { fetch: f = fetch, smtp = {} } = {}) {
  const transport = mailTransport(vars);
  if (transport === null)
    return Promise.resolve(
      row("Почта: вход", "fail", "WIZARD_MAIL_TRANSPORT: допустимо smtp или unisender-api"),
    );
  if (transport === "unisender-api" && vars.WIZARD_SMTP_HOST) return probeMailApi(vars, { fetch: f });
  return probeSmtp(vars, smtp);
}

/** WIZARD_SMTP_FROM: an address; its domain should be the platform's (DKIM/SPF are set up for it). */
export function probeFrom(vars) {
  const title = "Почта: отправитель";
  if (!vars.WIZARD_SMTP_FROM) return row(title, "skipped", "WIZARD_SMTP_FROM не задан");
  const from = parseFrom(vars.WIZARD_SMTP_FROM);
  if (!from) return row(title, "fail", "WIZARD_SMTP_FROM: нужен вид «Wizard <noreply@домен платформы>»");
  const platform = String(vars.WIZARD_PLATFORM_DOMAIN ?? "").toLowerCase();
  const warnings = [];
  if (platform && from.domain !== platform)
    warnings.push(
      "домен WIZARD_SMTP_FROM не совпадает с WIZARD_PLATFORM_DOMAIN: письма могут уходить в спам (DKIM и SPF настроены на домен платформы)",
    );
  return row(
    title,
    "ok",
    platform && from.domain === platform ? "адрес на домене платформы" : "адрес в порядке",
    { warnings },
  );
}

/** WIZARD_PLATFORM_MAIL_SPF (variable): only the mechanisms between `v=spf1` and `-all`. */
export function probeSpf(vars) {
  const title = "Почта: SPF домена платформы";
  const v = vars.WIZARD_PLATFORM_MAIL_SPF;
  if (!v)
    return row(title, "skipped", "WIZARD_PLATFORM_MAIL_SPF не задан: запись SPF платформы выкат не создаст", {
      required: false,
    });
  const why = checkSpf(v);
  return why
    ? row(title, "fail", `WIZARD_PLATFORM_MAIL_SPF: ${why}`)
    : row(title, "ok", `«v=spf1 ${v} -all»`);
}

// ---- Alerts ----

/** Telegram: getMe (bot username), then the test message to WIZARD_OPS_ALERT_CHAT_ID. */
export async function probeTelegram(vars, { fetch: f = fetch, base = TELEGRAM_API } = {}) {
  const title = "Алерты: Telegram";
  const token = vars.WIZARD_OPS_ALERT_TELEGRAM_TOKEN;
  if (!token)
    return row(
      title,
      "skipped",
      vars.WIZARD_OPS_ALERT_URL
        ? "задан WIZARD_OPS_ALERT_URL: адрес не проверяется"
        : "бот не задан: алерты придут только письмом",
      { required: false },
    );
  if (!TG_TOKEN.test(token))
    return row(title, "fail", "WIZARD_OPS_ALERT_TELEGRAM_TOKEN: нужен токен бота вида 123456:ABC…");
  const me = await call(f, `${base}/bot${token}/getMe`);
  if (me.status === 0) return row(title, "fail", noAnswer(me));
  if (me.status === 401 || me.status === 404)
    return row(
      title,
      "fail",
      "WIZARD_OPS_ALERT_TELEGRAM_TOKEN отклонён Telegram: возьмите токен у @BotFather заново",
    );
  if (me.status !== 200 || !me.json?.ok) return row(title, "fail", `getMe: HTTP ${me.status}`);
  const bot = `@${me.json.result?.username ?? "?"}`;
  if (!vars.WIZARD_OPS_ALERT_CHAT_ID)
    return row(title, "fail", `бот ${bot}, но WIZARD_OPS_ALERT_CHAT_ID не задан`);
  const sent = await call(f, `${base}/bot${token}/sendMessage`, {
    method: "POST",
    body: { chat_id: vars.WIZARD_OPS_ALERT_CHAT_ID, text: ALERT_TEXT },
  });
  if (sent.status === 200 && sent.json?.ok)
    return row(title, "ok", `бот ${bot}, тестовое сообщение отправлено`);
  const desc = String(sent.json?.description ?? "").slice(0, 120);
  const hint = /chat not found|bot can't initiate|bot was blocked/i.test(desc)
    ? ": напишите боту любое сообщение и проверьте WIZARD_OPS_ALERT_CHAT_ID"
    : "";
  return row(
    title,
    "fail",
    `бот ${bot}, сообщение не отправлено (${sent.status === 0 ? sent.error : `HTTP ${sent.status}`}${desc ? `, ${desc}` : ""})${hint}`,
  );
}

// ---- Report ----

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Russian Markdown table for GITHUB_STEP_SUMMARY. */
export function summaryTable(env, results) {
  const failed = results.filter((r) => r.status === "fail" && r.required);
  const lines = [
    `## Пилот ${env}: проверка настроек`,
    "",
    "Только чтение: ничего не создано и не изменено. Значения секретов не печатаются.",
    "",
    "| Проверка | Итог | Подробности |",
    "|---|---|---|",
    ...results.map((r) => {
      const status = r.status === "fail" && !r.required ? "ошибка (необязательно)" : STATUS_TEXT[r.status];
      const detail = [r.detail, ...r.warnings.map((w) => `внимание: ${w}`)].join("; ");
      return `| ${cell(r.title)} | ${status} | ${cell(detail)} |`;
    }),
    "",
    failed.length === 0
      ? `**Итог:** обязательные проверки пройдены. Запускайте bootstrap-pilot с action = apply${env === "prod" ? " и словом PROD" : ""}.`
      : `**Итог:** ошибок — ${failed.length}. Исправьте секреты или переменные GitHub и запустите check ещё раз.`,
  ];
  return lines.join("\n");
}

/**
 * All probes. inputProblems: [[name, why]] of checkInputs; stagingProblems: of envVars (staging only); stateProbe:
 * optional async () => row fields {status, detail} for the state bucket and the passphrase. Returns the exit code
 * (1 when a required item fails) after logging the table, ::error / ::warning lines and the step summary.
 */
export async function runPreflight({
  env,
  vars,
  inputProblems = [],
  stagingProblems = [],
  stateProbe,
  fetch: f = fetch,
  smtp = {},
  log = (s) => console.log(s),
  summary = () => {},
}) {
  const scrub = scrubber(vars);
  const results = [];
  const staging = new Set(stagingProblems.length ? ["WIZARD_PLATFORM_DOMAIN", "WIZARD_SYSTEMS_DOMAIN"] : []);
  const inputs = inputProblems.filter(([n, why]) => !(staging.has(n) && why.startsWith("не задан")));
  results.push(
    inputs.length === 0
      ? row("Настройки GitHub", "ok", "все обязательные секреты и переменные заданы")
      : row("Настройки GitHub", "fail", inputs.map(([n, why]) => `${n} — ${why}`).join("; ")),
  );
  if (env === "staging")
    results.push(
      stagingProblems.length === 0
        ? row("Домены staging", "ok", "заданы отдельно от prod")
        : row("Домены staging", "fail", stagingProblems.map(([n, why]) => `${n} — ${why}`).join("; ")),
    );
  const bad = new Set(inputProblems.map(([n]) => n));
  const twc = await probeTimeweb(vars, { fetch: f });
  results.push(twc);
  const twcOk = twc.status === "ok";
  // staging reads its domains from WIZARD_STAGING_* (envVars): the rows name the variable the founder sets.
  const shownName = (name) => (env === "staging" ? name.replace("WIZARD_", "WIZARD_STAGING_") : name);
  const domain = (name, label) =>
    !twcOk
      ? Promise.resolve(
          row(`Timeweb Cloud: ${label} (${shownName(name)})`, "skipped", "сначала нужен рабочий TWC_TOKEN"),
        )
      : bad.has(name)
        ? Promise.resolve(
            row(
              `Timeweb Cloud: ${label} (${shownName(name)})`,
              "skipped",
              `${shownName(name)} не задан или неверен`,
            ),
          )
        : probeDomain(vars, name, label, { fetch: f, shown: shownName(name) });
  const state = async () => {
    const title = "Бакет состояния и WIZARD_STATE_PASSPHRASE";
    if (!stateProbe) return row(title, "skipped", "не проверялся");
    if (!twcOk) return row(title, "skipped", "сначала нужен рабочий TWC_TOKEN");
    if (bad.has("WIZARD_STATE_PASSPHRASE"))
      return row(title, "skipped", "WIZARD_STATE_PASSPHRASE не задан или короткий");
    try {
      const r = await stateProbe();
      return row(title, r.status, r.detail);
    } catch (e) {
      return row(title, "fail", e instanceof Error ? e.message : String(e));
    }
  };
  results.push(
    ...(await Promise.all([
      domain("WIZARD_PLATFORM_DOMAIN", "домен платформы"),
      domain("WIZARD_SYSTEMS_DOMAIN", "домен систем"),
      state(),
      probeCloudru(vars, { fetch: f }),
      probeZai(vars, { fetch: f }),
      probeMail(vars, { fetch: f, smtp }),
      Promise.resolve(probeFrom(vars)),
      Promise.resolve(probeSpf(vars)),
      probeTelegram(vars, { fetch: f }),
    ])),
    ...(await probeStock(vars, { fetch: f })),
  );

  const width = Math.max(...results.map((r) => r.title.length));
  for (const r of results) {
    log(scrub(`${STATUS_TEXT[r.status].padEnd(10)} ${r.title.padEnd(width)}  ${r.detail}`));
    for (const w of r.warnings) log(scrub(`::warning title=pilot check::${r.title}: ${w}`));
    if (r.status === "fail")
      log(scrub(`::${r.required ? "error" : "warning"} title=pilot check::${r.title}: ${r.detail}`));
  }
  summary(scrub(`${summaryTable(env, results)}\n`));
  return results.some((r) => r.status === "fail" && r.required) ? 1 : 0;
}
