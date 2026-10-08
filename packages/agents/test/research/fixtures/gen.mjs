#!/usr/bin/env node
// Recorded answers of research tests (V3-05) in the format of the CI probe (RecordedExchange[]: key, status,
// headers, body): Yandex Search API v2 answers ({rawData: base64 of the XML}), an article page with robots.txt,
// redirects, and the documentation of two domains (llms.txt, openapi.json, api-catalog, sitemap). Synthetic: hosts
// under the reserved .example TLD. `node gen.mjs` rewrites exchanges.json; the test checks the file matches.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SEARCH_URL = "https://searchapi.api.cloud.yandex.net/v2/web/search";
export const CLINIC = "https://klinika-kazan.example";
export const PAY = "https://api.pay-docs.example";
export const SHOP = "https://shop-docs.example";

// Numeric character references (&#8381;) stay as the engine sends them.
const esc = (s) =>
  s
    .replace(/&(?!#\d+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** <doc> of the XML answer; `hl` wraps words in <hlword> like the engine does. */
function doc({ url, domain, title, passages = [], headline }) {
  const hl = (s) => esc(s).replace(/\{(.+?)\}/g, "<hlword>$1</hlword>");
  return [
    "<group>",
    `<categ attr="d" name="${domain}"/>`,
    "<doccount>12</doccount>",
    '<doc id="Z0">',
    `<url>${esc(url)}</url>`,
    `<domain>${domain}</domain>`,
    `<title>${hl(title)}</title>`,
    headline ? `<headline>${hl(headline)}</headline>` : "",
    "<modtime>20261001T120000</modtime>",
    "<size>48211</size>",
    "<charset>utf-8</charset>",
    passages.length
      ? `<passages>${passages.map((p) => `<passage>${hl(p)}</passage>`).join("")}</passages>`
      : "",
    "<properties><_PassagesType>0</_PassagesType><lang>ru</lang></properties>",
    "<mime-type>text/html</mime-type>",
    "</doc>",
    "</group>",
  ].join("");
}

function xmlAnswer({ query, docs, error }) {
  const body = error
    ? `<error code="${error.code}">${esc(error.text)}</error>`
    : [
        "<reqid>1759999999999999-1234567890-search-api</reqid>",
        '<found priority="phrase">1200</found>',
        '<found priority="strict">1300</found>',
        '<found priority="all">2400</found>',
        "<found-human>Нашлось 2 тыс. результатов</found-human>",
        '<results><grouping attr="d" mode="deep" groups-on-page="10" docs-in-group="1" curcateg="-1">',
        '<found priority="all">2400</found>',
        '<page first="1" last="10">0</page>',
        ...docs.map(doc),
        "</grouping></results>",
      ].join("");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch version="1.0"><request><query>${esc(query)}</query><page>0</page><sortby order="descending" priority="no">rlv</sortby><maxpassages>2</maxpassages><groupings><groupby attr="d" mode="deep" groups-on-page="10" docs-in-group="1" curcateg="-1"/></groupings></request><response date="20261008T101500">${body}</response></yandexsearch>`;
  return JSON.stringify({ rawData: Buffer.from(xml, "utf8").toString("base64") });
}

const search = (query, answer, status = 200) => ({
  key: `SEARCH ${query}|225|0`,
  status,
  headers: { "content-type": "application/json" },
  body: answer,
});
const get = (url, status, contentType, body, extra = {}) => ({
  key: `GET ${url}`,
  status,
  headers: { ...(contentType ? { "content-type": contentType } : {}), ...extra },
  body,
});

const DENTAL_DOCS = [
  {
    url: `${CLINIC}/uslugi`,
    domain: "klinika-kazan.example",
    title: "{Стоматология} в {Казани} — {услуги} и цены",
    passages: ["Лечение кариеса, имплантация, чистка. Консультация — 500 &#8381;", "Работаем без выходных"],
  },
  {
    url: "https://dent-reviews.example/kazan",
    domain: "dent-reviews.example",
    title: "Рейтинг клиник «Казань» & отзывы",
    headline: "Сравнение 40 клиник по ценам и отзывам",
  },
  // The engine may repeat a URL in another group: it is kept once.
  { url: `${CLINIC}/uslugi`, domain: "klinika-kazan.example", title: "Дубль", passages: ["дубль"] },
  {
    url: "https://price-list.example/dental/kazan?from=search",
    domain: "price-list.example",
    title: "Цены на {услуги} {стоматологии}",
    passages: ["Средняя цена имплантации в Казани — 38 000 ₽"],
  },
];

const ARTICLE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Как выбрать стоматологию в Казани — блог клиники</title>
<style>body{font:16px sans-serif}</style><script>window.metrika=1</script></head>
<body>
<header><nav><a href="/">Главная</a> <a href="/uslugi">Услуги</a> <a href="/kontakty">Контакты</a></nav></header>
<main><article>
<h1>Как выбрать стоматологию в Казани</h1>
<p class="byline">Блог клиники, 1 октября 2026</p>
<p>Выбор клиники начинается с лицензии: её номер должен быть на сайте и в договоре. Затем смотрят на отзывы за последний год и на то, называют ли цены до приёма. Хорошая клиника показывает прайс открыто и объясняет план лечения.</p>
<h2>На что смотреть</h2>
<ul><li>Лицензия на медицинскую деятельность</li><li>Открытый прайс и смета до лечения</li><li>Гарантия на пломбы и импланты</li></ul>
<p>Подробные цены — <a href="/uslugi#ceny">в разделе услуг</a>, запись — <a href="javascript:void(0)">по кнопке</a>.</p>
<img src="/img/kabinet.jpg" alt="Кабинет">
<h2>Сколько стоит</h2>
<p>Консультация стоит от 500 ₽, профессиональная чистка — от 3 500 ₽, имплантация под ключ — от 38 000 ₽. Цены зависят от материала и сложности случая, поэтому окончательную смету даёт врач после осмотра.</p>
<form><input name="phone"><button>Записаться</button></form>
</article></main>
<aside>Акция месяца: скидка 10 %</aside>
<footer>© 2026 Клиника · <a href="/privacy">Политика</a></footer>
</body></html>
`;

const LLMS = `# Pay Docs API

> API приёма платежей: платежи, возвраты, чеки и уведомления. Документация для разработчиков и LLM.

Версия API v3. Авторизация — HTTP Basic (shopId и секретный ключ).

## Документация

- [Быстрый старт](https://pay-docs.example/developers/quickstart): первый платёж за 10 минут
- [Платежи](/developers/payments): создание, подтверждение и отмена
- [Возвраты](/developers/refunds)

## Спецификации

- [OpenAPI](https://api.pay-docs.example/openapi.json): полная спецификация API v3

## Optional

- [Changelog](https://pay-docs.example/changelog)
`;

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Pay Docs API", version: "3.0.0" },
  servers: [{ url: "https://api.pay-docs.example/v3" }],
  paths: {
    "/payments": {
      post: { operationId: "createPayment", summary: "Создать платёж" },
      get: { operationId: "listPayments", summary: "Список платежей" },
    },
    "/payments/{payment_id}": { get: { operationId: "getPayment", summary: "Информация о платеже" } },
    "/payments/{payment_id}/capture": {
      post: { operationId: "capturePayment", summary: "Подтвердить платёж" },
    },
    "/refunds": { post: { operationId: "createRefund", summary: "Создать возврат" } },
    "/webhooks": {
      post: { operationId: "createWebhook", description: "Подписка на уведомления о событиях" },
    },
  },
};

const API_CATALOG = {
  linkset: [
    {
      anchor: "https://api.pay-docs.example/v3",
      "service-desc": [{ href: "https://api.pay-docs.example/openapi.json", type: "application/json" }],
      "service-doc": [{ href: "https://pay-docs.example/developers", type: "text/html" }],
    },
  ],
};

const urlset = (urls) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc><lastmod>2026-09-30</lastmod></url>`)
    .join("")}</urlset>\n`;

/** All recorded exchanges of the research tests. */
export function exchanges() {
  return [
    // Search.
    search(
      "стоматология Казань услуги",
      xmlAnswer({ query: "стоматология Казань услуги", docs: DENTAL_DOCS }),
    ),
    // The query of the chat had a name and a phone: only what is left after scrub reaches the engine.
    search(
      "клиника отзывы",
      xmlAnswer({
        query: "клиника отзывы",
        docs: [
          { url: "https://otzyvy.example/kliniki", domain: "otzyvy.example", title: "Отзывы о клиниках" },
        ],
      }),
    ),
    search(
      "абвгд несуществующий запрос",
      xmlAnswer({
        query: "абвгд несуществующий запрос",
        error: { code: 15, text: "Искомая комбинация слов нигде не встречается" },
      }),
    ),
    search("ключ отозван", JSON.stringify({ code: 16, message: "Unauthenticated", details: [] }), 401),
    // Pages of the clinic.
    get(
      `${CLINIC}/robots.txt`,
      200,
      "text/plain",
      "User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: OtherBot\nDisallow: /\n\nSitemap: https://klinika-kazan.example/sitemap.xml\n",
    ),
    get(`${CLINIC}/blog/kak-vybrat`, 200, "text/html; charset=utf-8", ARTICLE),
    get(`${CLINIC}/old-blog`, 301, null, "", { location: "/blog/kak-vybrat" }),
    get(`${CLINIC}/go`, 302, null, "", { location: "http://169.254.169.254/latest/meta-data/" }),
    get(`${CLINIC}/price.txt`, 200, "text/plain; charset=utf-8", "Консультация 500\nЧистка 3500\n"),
    get(`${CLINIC}/price.pdf`, 200, "application/pdf", "%PDF-1.7 ..."),
    get(`${CLINIC}/gone`, 404, "text/html", "<h1>Нет такой страницы</h1>"),
    get(
      `${CLINIC}/sitemap.xml`,
      200,
      "application/xml",
      urlset([`${CLINIC}/`, `${CLINIC}/uslugi`, `${CLINIC}/blog/kak-vybrat`]),
    ),
    // Documentation of the payment API.
    get(`${PAY}/robots.txt`, 404, "text/html", "<h1>404</h1>"),
    get(`${PAY}/llms.txt`, 200, "text/plain; charset=utf-8", LLMS),
    get(`${PAY}/openapi.json`, 200, "application/json", JSON.stringify(OPENAPI)),
    get(`${PAY}/swagger.json`, 404, "application/json", '{"error":"not found"}'),
    get(`${PAY}/.well-known/api-catalog`, 200, "application/linkset+json", JSON.stringify(API_CATALOG)),
    get(
      `${PAY}/sitemap.xml`,
      200,
      "application/xml",
      urlset([`${PAY}/v3`, "https://api.pay-docs.example/v3/payments-guide"]),
    ),
    // A shop whose missing pages answer 200 with HTML (soft 404) and whose sitemap is an index named in robots.txt.
    get(
      `${SHOP}/robots.txt`,
      200,
      "text/plain",
      "User-agent: *\nDisallow:\nSitemap: https://shop-docs.example/sitemap_index.xml\n",
    ),
    get(`${SHOP}/llms.txt`, 200, "text/html", "<!doctype html><html><body>Страница не найдена</body></html>"),
    get(
      `${SHOP}/openapi.json`,
      200,
      "text/html; charset=utf-8",
      "<!DOCTYPE html><html><body>Каталог</body></html>",
    ),
    get(
      `${SHOP}/swagger.json`,
      200,
      "application/json",
      JSON.stringify({
        swagger: "2.0",
        info: { title: "Shop", version: "1" },
        host: "shop-docs.example",
        basePath: "/api",
        schemes: ["https"],
        paths: { "/orders": { get: { operationId: "listOrders", summary: "Заказы" } } },
      }),
    ),
    get(`${SHOP}/.well-known/api-catalog`, 404, "text/html", ""),
    get(
      `${SHOP}/sitemap_index.xml`,
      200,
      "application/xml",
      '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://shop-docs.example/sitemap-1.xml</loc></sitemap><sitemap><loc>https://shop-docs.example/sitemap-2.xml</loc></sitemap></sitemapindex>',
    ),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = join(import.meta.dirname, "exchanges.json");
  writeFileSync(out, `${JSON.stringify(exchanges(), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
