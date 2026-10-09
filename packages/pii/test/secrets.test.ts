// V3-21: access keys typed as text (security/data-boundary.yaml#secret_window.interception). Keys are generated here
// from a seeded alphabet walk — never literal provider keys in the repository (secret scanning), never printed.
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/log.js";
import { detectSecrets, hasSecret, maskSecrets, replaceSecrets, SECRET_MASK } from "../src/secrets.js";

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
let seed = 20261009;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const gen = (n: number, abc = ALNUM) =>
  Array.from({ length: n }, () => abc[Math.floor(rnd() * abc.length)]).join("");
/** Random keys of the formats the detector knows: [label, key]. */
const KEYS: [string, () => string][] = [
  ["openai", () => `${"s"}k-proj-${gen(40)}`],
  ["anthropic", () => `${"s"}k-ant-api03-${gen(40)}`],
  ["github", () => `${"g"}hp_${gen(36)}`],
  ["github_pat", () => `${"github"}_pat_${gen(22)}_${gen(40)}`],
  ["gitlab", () => `${"gl"}pat-${gen(20)}`],
  ["stripe", () => `${"s"}k_live_${gen(24)}`],
  ["aws", () => `${"AK"}IA${gen(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`],
  ["google", () => `${"AI"}za${gen(35)}`],
  ["telegram", () => `${gen(10, "0123456789")}:AA${gen(33)}`],
  ["yookassa", () => `${"live"}_${gen(40)}`],
  ["yandex_cloud", () => `${"AQ"}VN${gen(36)}`],
  ["jwt", () => `${"ey"}J${gen(20)}.eyJ${gen(40)}.${gen(43)}`],
  ["zai", () => `${gen(32, HEX)}.${gen(16)}`],
  ["bitrix24", () => `https://shop.bitrix24.ru/rest/1/${gen(16, "abcdefghijklmnopqrstuvwxyz0123456789")}/`],
];

describe("detectSecrets: provider formats", () => {
  for (const [label, make] of KEYS)
    test(`${label}: found alone, inside a Russian sentence and masked`, () => {
      for (let i = 0; i < 5; i++) {
        const key = make();
        expect(hasSecret(key), label).toBe(true);
        const text = `Вот доступ для интеграции: ${key} — подключите, пожалуйста`;
        const [f] = detectSecrets(text);
        expect(f, label).toBeDefined();
        expect(text.slice(f?.start, f?.end) === key, label).toBe(true);
        const masked = maskSecrets(text);
        expect(masked.count).toBe(1);
        expect(masked.text.includes(key), label).toBe(false);
        expect(masked.text).toContain(SECRET_MASK);
      }
    });
});

describe("detectSecrets: generic keys", () => {
  test("a high-entropy token next to «ключ», «токен», «api», «token»", () => {
    for (const lead of ["Ключ API СДЭК:", "мой токен", "api key", "Token для amoCRM —", "секретный ключ"]) {
      const key = gen(32);
      const text = `${lead} ${key}`;
      const f = detectSecrets(text);
      expect(f.length === 1 && text.slice(f[0]?.start, f[0]?.end) === key, lead).toBe(true);
    }
    const hex = gen(40, HEX);
    expect(hasSecret(`ключ DaData: ${hex}`)).toBe(true);
    expect(hasSecret(`apiKey=${gen(24)}`)).toBe(true);
  });

  test("assignments, headers, URLs with credentials and secret parameters, private keys", () => {
    const v = gen(24);
    const cases = [
      `client_secret: "${v}"`,
      `пароль = ${v}`,
      `{"api_key": "${v}"}`,
      `Authorization: Bearer ${v}`,
      `postgres://app:${v}@db.example.ru/app`,
      `https://api.example.ru/v1/orders?apikey=${v}&x=1`,
    ];
    for (const text of cases) {
      const f = detectSecrets(text);
      expect(f.length, text.slice(0, 6)).toBe(1);
      expect(text.slice(f[0]?.start, f[0]?.end) === v, text.slice(0, 6)).toBe(true);
    }
    const pem = `-----BEGIN PRIVATE KEY-----\n${gen(64)}\n${gen(64)}\n-----END PRIVATE KEY-----`;
    expect(detectSecrets(`ключ:\n${pem}`)[0]?.kind).toBe("private_key");
  });

  test("a message that is one bare random token (chat only)", () => {
    const key = gen(28);
    expect(hasSecret(key)).toBe(true);
    expect(hasSecret(`  ${key}\n`)).toBe(true);
    expect(hasSecret(key, { context: "log" })).toBe(false);
  });

  test("replaceSecrets puts a reference in place of the key", () => {
    const key = KEYS[0]?.[1]() ?? "";
    expect(replaceSecrets(`подключи ${key} к CRM`, () => "secret://crm_key")).toBe(
      "подключи secret://crm_key к CRM",
    );
  });
});

describe("detectSecrets: no false alarms on ordinary chat", () => {
  const ordinary = [
    "Привет! Сделай сайт для кофейни в Казани с онлайн-записью",
    "Ключевые клиенты — студенты; пароль от wi-fi пишем на чеке",
    "Нужна интеграция с API amoCRM: заявки с сайта в воронку «Новые»",
    "secret://yookassa_key уже есть, используй его",
    "Ключ: secret://crm_key",
    "Откройте https://partner-crm.ru/docs/api/v1/openapi.json и подключите заявки",
    "Заказ 8c1e5f0a-3b2d-4e6f-9a7b-1c2d3e4f5a6b оплачен, напишите клиенту",
    "Телефон +7 916 123-45-67, почта ivan.petrov@example.com, ИНН 7707083893",
    "api endpoint /api/v1/systems/orders/items возвращает список",
    "используй process.env.YOOKASSA_SECRET_KEY и getApiKeyFromEnvironment",
    "token: none, password: от 8 символов",
    "sk-landing-page-template-for-coffee",
    "Вставьте ключ сюда: <api-key> или your_api_key",
    "Версия 2026-10-09, сборка №12, цена 1 500 ₽",
    "ORD-2026-10-09-KZN-000123-B7",
    "kazan-dental-clinic-2026-landing",
  ];
  for (const text of ordinary)
    test(text.slice(0, 40), () => {
      expect(detectSecrets(text)).toEqual([]);
    });

  test("a UUID near «api» alone is not a key; next to «ключ» it is", () => {
    const id = "3f2a7c1e-9b4d-4e8a-b1c2-7d6e5f4a3b2c";
    expect(hasSecret(`запрос api ${id}`)).toBe(false);
    expect(hasSecret(`API-ключ СДЭК ${id}`)).toBe(true);
  });
});

describe("logs (createLogger): a key never reaches a line", () => {
  test("msg, err and allowlisted fields are masked; the canary is absent", () => {
    const canary = `${"s"}k-proj-${gen(40)}`;
    const lines: string[] = [];
    const log = createLogger({ svc: "test", write: (j) => lines.push(j) });
    log.info(`ключ ${canary} получен`, { reason: `token=${canary}`, url: `https://x.ru/a?key=${canary}` });
    log.error("сбой", new Error(`Bearer ${canary}`));
    log.line({ level: "warn", msg: canary, code: "X" });
    const all = lines.join("\n");
    expect(all.includes(canary)).toBe(false);
    expect(all).toContain(SECRET_MASK);
    expect(lines).toHaveLength(3);
  });
});
