#!/usr/bin/env node
// Provider key probe for V4-05/V4-13 (D79 (5)): one cheap request per key — list models, one tiny chat
// completion, and a vision question for Z.ai. Never prints keys. Node 22, no dependencies.
// Run: node tools/llm-probe/probe.mjs  (keys come from env; missing keys are reported, not fatal).
import { deflateSync } from "node:zlib";

const TIMEOUT_MS = 45_000;

/** Candidates: env var with the key, base URLs to try in order, model preference regexes (first match wins). */
const TARGETS = [
  { name: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", bases: ["https://api.deepseek.com/v1"], prefer: [/v4.*flash/i, /chat/i, /./] },
  { name: "Kimi", keyEnv: "KIMI_API_KEY", bases: ["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"], prefer: [/k3/i, /k2\.?6/i, /kimi/i, /./] },
  { name: "MiMo (MIMO_API_KEY)", keyEnv: "MIMO_API_KEY", bases: ["https://api.xiaomimimo.com/v1"], prefer: [/v2\.?6.*pro/i, /pro/i, /flash/i, /./] },
  { name: "MiMo (MIMO_SECOND_API_KEY)", keyEnv: "MIMO_SECOND_API_KEY", bases: ["https://api.xiaomimimo.com/v1"], prefer: [/v2\.?6.*pro/i, /pro/i, /flash/i, /./] },
  { name: "Z.ai", keyEnv: "ZAI_API_KEY", bases: [process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4"], prefer: [/glm-5\.3$/i, /glm-5/i, /./], vision: [/5v|5\.\d*v/i, /4\.6v/i, /v$/i] },
];

async function call(url, key, body) {
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ms: Date.now() - t0, json, text: text.slice(0, 300) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, json: null, text: String(e?.cause?.code ?? e?.message ?? e).slice(0, 200) };
  }
}

/** 16×16 solid red PNG as a data URI (vision check: the answer must name the colour). */
function redPng() {
  const w = 16, h = 16;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([220, 20, 20]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const pick = (ids, prefs) => { for (const re of prefs) { const m = ids.find((id) => re.test(id)); if (m) return m; } return ids[0]; };
const reply = (r) => r.json?.choices?.[0]?.message?.content ?? r.json?.error?.message ?? r.text;
const lines = [];
const out = (s) => { lines.push(s); console.log(s); };

out("| Провайдер | Ключ | Базовый URL | /models | Модель | Ответ чата | Зрение |");
out("|---|---|---|---|---|---|---|");
for (const t of TARGETS) {
  const key = process.env[t.keyEnv];
  if (!key) { out(`| ${t.name} | нет секрета ${t.keyEnv} | — | — | — | — | — |`); continue; }
  let done = false;
  for (const base of t.bases) {
    const models = await call(`${base}/models`, key);
    const ids = Array.isArray(models.json?.data) ? models.json.data.map((m) => m.id).filter(Boolean) : [];
    if (models.status === 401 || models.status === 403) { out(`| ${t.name} | есть | ${base} | ${models.status} (${reply(models).slice(0, 80)}) | — | — | — |`); continue; }
    const model = ids.length ? pick(ids, t.prefer) : "";
    const chatModel = model || (t.keyEnv === "DEEPSEEK_API_KEY" ? "deepseek-chat" : t.keyEnv.startsWith("MIMO") ? "mimo-v2-flash" : t.keyEnv === "ZAI_API_KEY" ? "glm-5.3" : "kimi-k2-turbo-preview");
    const chat = await call(`${base}/chat/completions`, key, { model: chatModel, max_tokens: 16, temperature: 0, messages: [{ role: "user", content: "Ответь одним словом по-русски: столица России?" }] });
    let vision = "—";
    if (t.vision) {
      const vModel = pick(ids.length ? ids : ["glm-5v", "glm-4.6v"], t.vision);
      const v = await call(`${base}/chat/completions`, key, { model: vModel, max_tokens: 16, temperature: 0, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: redPng() } }, { type: "text", text: "Какого цвета картинка? Одно слово." }] }] });
      vision = `${vModel}: ${v.status} ${String(reply(v)).replace(/\s+/g, " ").slice(0, 60)}`;
    }
    const shown = ids.length ? `${models.status}, ${ids.length} шт.: ${ids.slice(0, 12).join(", ")}` : `${models.status}`;
    out(`| ${t.name} | есть | ${base} | ${shown} | ${chatModel} | ${chat.status} ${String(reply(chat)).replace(/\s+/g, " ").slice(0, 60)} (${chat.ms} мс) | ${vision} |`);
    done = chat.status === 200;
    if (done) break;
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Проба провайдеров\n\n${lines.join("\n")}\n`);
}
