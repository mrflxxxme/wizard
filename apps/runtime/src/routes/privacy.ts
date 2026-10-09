// 152-ФЗ pages of a system (security/compliance.yaml#system_package; runtime.yaml#service_endpoints.privacy):
// the policy page (compliance.policyPage, role public), /_wizard/privacy (consent withdrawal of a logged-in user),
// /_wizard/pd-requests (subject requests, isAdmin roles) and its API /api/admin/pd-requests/*.
import { quoteIdent } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { sessionOf } from "../http/subject.js";
import { documentHeaders, escapeHtml, htmlPage } from "../preview/headers.js";
import { readObjectBody } from "../preview/http.js";
import { markdownToHtml, renderPolicy } from "../privacy/policy.js";
import { renderShopTerms, type ShopTermsKind } from "../privacy/shop-terms.js";
import { eraseSubject, exportSubject, findSubject, parseSubjectQuery } from "../privacy/subject.js";
import { defaultLegalTemplates } from "../privacy/templates.js";

const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" };

function policyDate(c: RuntimeContext): string {
  const published = Date.parse(c.get("system").entry.publishedAt);
  const at = Number.isFinite(published) && published > 0 ? new Date(published) : c.get("services").clock();
  return at.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
}

/** GET <policyPage>: lawyer's template + facts of the spec; the version equals RoleSpec.compliance.policyVersion. */
export function policyPage(c: RuntimeContext): Response {
  const sys = c.get("system");
  const templates = c.get("services").legalTemplates ?? defaultLegalTemplates();
  const policy = renderPolicy(sys.spec, templates, policyDate(c));
  if (!policy) {
    const body = "<p>Политика обработки персональных данных пока не опубликована.</p>";
    return c.body(htmlPage("Политика обработки персональных данных", body), 200, documentHeaders());
  }
  const lines = policy.markdown.split("\n");
  const head = /^#\s+(.*)$/.exec(lines[0] ?? "");
  const title = head ? (head[1] as string) : "Политика обработки персональных данных";
  const body = `<div data-testid="wz-policy" data-policy-version="${escapeHtml(policy.version)}">${markdownToHtml(
    (head ? lines.slice(1) : lines).join("\n"),
  )}</div>`;
  return c.body(htmlPage(title, body), 200, documentHeaders());
}

/** GET /offer, /delivery, /returns of a shop (V3-18): the lawyer's template + the seller's requisites of the spec. */
export function shopTermsPage(c: RuntimeContext, kind: ShopTermsKind): Response {
  const sys = c.get("system");
  const templates = c.get("services").legalTemplates ?? defaultLegalTemplates();
  const page = renderShopTerms(sys.spec, templates, kind);
  if (!page)
    return c.body(
      htmlPage("Условия магазина", "<p>Страница пока не опубликована.</p>"),
      200,
      documentHeaders(),
    );
  const lines = page.markdown.split("\n");
  const head = /^#\s+(.*)$/.exec(lines[0] ?? "");
  const body = `<div data-testid="wz-shop-terms" data-terms="${kind}">${markdownToHtml((head ? lines.slice(1) : lines).join("\n"))}</div>`;
  return c.body(htmlPage(head ? (head[1] as string) : page.title, body), 200, documentHeaders());
}

const PRIVACY_JS = `(function(){var b=document.getElementById("wz-privacy-revoke");if(!b)return;var m=document.getElementById("wz-privacy-status");b.addEventListener("click",function(){if(!window.confirm("Отозвать согласие? Вход будет закрыт, ваши данные будут обезличены."))return;b.disabled=true;fetch("/api/auth/consent/revoke",{method:"POST",credentials:"same-origin",headers:{"X-Wizard-Request":"1"}}).then(function(r){if(r.ok){window.location.replace("/");return}b.disabled=false;m.textContent="Не удалось отозвать согласие, попробуйте позже"},function(){b.disabled=false;m.textContent="Нет связи с сервером"})})})();`;

const PD_JS = `(function(){var f=document.getElementById("wz-pd-form");if(!f)return;var out=document.getElementById("wz-pd-result");function body(){return JSON.stringify({email:f.elements.email.value,phone:f.elements.phone.value})}function call(op){return fetch("/api/admin/pd-requests/"+op,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Wizard-Request":"1"},body:body()})}function fail(r){return r.json().then(function(j){out.textContent=(j&&j.error&&j.error.message)||"Ошибка"},function(){out.textContent="Ошибка"})}function lost(){out.textContent="Нет связи с сервером"}function list(title,items){var l=[title];items.forEach(function(e){l.push(e.label+": "+e.rows)});if(!items.length)l.push("ничего не найдено");out.textContent=l.join("\\n")}f.addEventListener("submit",function(ev){ev.preventDefault();call("search").then(function(r){if(!r.ok)return fail(r);return r.json().then(function(j){list("Найдено (пользователей: "+j.users+"):",j.entities)})},lost)});document.getElementById("wz-pd-export").addEventListener("click",function(){call("export").then(function(r){if(!r.ok)return fail(r);return r.blob().then(function(b){var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="pd-export.json";document.body.appendChild(a);a.click();a.remove();out.textContent="Выгрузка сохранена в файл pd-export.json"})},lost)});document.getElementById("wz-pd-erase").addEventListener("click",function(){if(!window.confirm("Удалить персональные данные субъекта? Действие необратимо."))return;call("erase").then(function(r){if(!r.ok)return fail(r);return r.json().then(function(j){list("Обезличено записей:",j.entries)})},lost)})})();`;

async function consentOf(c: RuntimeContext, userId: string) {
  const sys = c.get("system");
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const rows = await d.sql.unsafe(
      `select policy_version, given_at from ${quoteIdent(sys.schema)}."_w_consents"
       where entity = 'users' and row_id = $1::uuid order by given_at desc limit 1`,
      [userId],
    );
    return rows[0] ?? null;
  });
}

/** Mounted at /_wizard: /privacy, /pd-requests and their scripts. */
export function privacyRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.get("/privacy", async (c) => {
    const sys = c.get("system");
    const s = await sessionOf(c).catch(() => null);
    const policy = sys.compliance.policyPage;
    const policyLink = policy
      ? `<p><a href="${escapeHtml(policy)}" data-testid="wz-privacy-policy-link">Политика обработки персональных данных</a></p>`
      : "";
    const contact = sys.spec.compliance?.operatorContact;
    const operator = contact
      ? `<p>Запросы о ваших данных (выгрузка, удаление): ${escapeHtml(contact)}</p>`
      : "";
    if (s?.subject.id == null) {
      const body = `<p>Чтобы управлять своими данными, <a href="/login?next=%2F_wizard%2Fprivacy">войдите</a>.</p>${operator}${policyLink}`;
      return c.body(htmlPage("Мои данные", body, ["/_wizard/privacy.js"]), 200, documentHeaders("no-store"));
    }
    const given = await consentOf(c, s.subject.id);
    const days = c.get("services").privacy?.withdrawalDays ?? 0;
    const when = days > 0 ? `не позднее чем через ${days} дн.` : "сразу";
    const consent = given
      ? `<p data-testid="wz-privacy-consent">Согласие дано ${escapeHtml(
          new Date(String(given.given_at)).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }),
        )}${given.policy_version === sys.compliance.policyVersion ? "" : " (к предыдущей редакции политики)"}.</p>`
      : "";
    const body = `${consent}<p>Вы можете отозвать согласие на обработку персональных данных. Мы завершим все ваши сеансы и закроем вход, а ваши контактные данные и персональные данные в ваших записях обезличим ${when}.</p>${operator}${policyLink}<p><button type="button" id="wz-privacy-revoke" data-testid="wz-privacy-revoke">Отозвать согласие</button></p><p id="wz-privacy-status" role="status"></p>`;
    return c.body(htmlPage("Мои данные", body, ["/_wizard/privacy.js"]), 200, documentHeaders("no-store"));
  });
  app.get("/privacy.js", (c) => c.body(PRIVACY_JS, 200, JS_HEADERS));

  app.get("/pd-requests", async (c) => {
    const s = await sessionOf(c).catch(() => null);
    const title = "Запросы субъектов персональных данных";
    if (s?.subject.id == null) {
      const body = `<p><a href="/login?next=%2F_wizard%2Fpd-requests">Войдите</a> под ролью администратора.</p>`;
      return c.body(htmlPage(title, body), 200, documentHeaders("no-store"));
    }
    if (!s.subject.isAdmin) {
      const body = "<p>Нет доступа: страница доступна только администраторам системы.</p>";
      return c.body(htmlPage(title, body), 403, documentHeaders("no-store"));
    }
    const body = [
      "<p>Найдите данные человека по email или телефону, затем выгрузите их или удалите. Ответить на запрос нужно не позднее 10 рабочих дней.</p>",
      '<form id="wz-pd-form" data-testid="wz-pd-form">',
      '<p><label>Email <input name="email" type="email" autocomplete="off" data-testid="wz-pd-email"></label></p>',
      '<p><label>Телефон <input name="phone" type="tel" autocomplete="off" data-testid="wz-pd-phone"></label></p>',
      '<p><button type="submit" data-testid="wz-pd-search">Найти</button> ',
      '<button type="button" id="wz-pd-export" data-testid="wz-pd-export">Выгрузить</button> ',
      '<button type="button" id="wz-pd-erase" data-testid="wz-pd-erase">Удалить</button></p>',
      "</form>",
      '<p id="wz-pd-result" role="status" data-testid="wz-pd-result" style="white-space:pre-line"></p>',
    ].join("");
    return c.body(htmlPage(title, body, ["/_wizard/pd-requests.js"]), 200, documentHeaders("no-store"));
  });
  app.get("/pd-requests.js", (c) => c.body(PD_JS, 200, JS_HEADERS));
  return app;
}

/** Mounted at /api/admin/pd-requests (isAdmin roles only). */
export function pdRequestsApiRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.use("*", async (c, next) => {
    const { subject } = await sessionOf(c);
    if (subject.id === null) throw new WizardError("UNAUTHENTICATED");
    if (!subject.isAdmin) throw new WizardError("FORBIDDEN");
    await next();
  });
  const log = (c: RuntimeContext, op: string, rows: number) => {
    const sys = c.get("system");
    c.get("services").log?.({
      ts: new Date().toISOString(),
      level: "info",
      msg: "subject_request",
      system: sys.entry.slug,
      env: sys.entry.env,
      op,
      rows,
    });
  };
  const admin = async (c: RuntimeContext) => (await sessionOf(c)).subject.id as string;

  app.post("/search", async (c) => {
    const q = parseSubjectQuery(await readObjectBody(c));
    const r = await findSubject(c.get("system"), q);
    return c.json(r, 200, { "Cache-Control": "no-store" });
  });
  app.post("/export", async (c) => {
    const q = parseSubjectQuery(await readObjectBody(c));
    const doc = await exportSubject(c.get("system"), q, await admin(c), c.get("services").clock());
    log(
      c,
      "export",
      doc.entities.reduce((n, e) => n + e.rows.length, doc.users.length),
    );
    return c.body(JSON.stringify(doc, null, 2), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="pd-export.json"',
      "Cache-Control": "no-store",
    });
  });
  app.post("/erase", async (c) => {
    const sys = c.get("system");
    const q = parseSubjectQuery(await readObjectBody(c));
    const r = await eraseSubject(sys, q, await admin(c));
    const label = (name: string) =>
      name === "users" ? "Пользователи" : (sys.spec.entities.find((e) => e.name === name)?.label ?? name);
    log(
      c,
      "erase",
      r.entries.reduce((n, e) => n + e.rows, 0),
    );
    return c.json(
      {
        entries: r.entries.map((e) => ({ entity: e.entity, label: label(e.entity), rows: e.rows })),
        pending: r.pending,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });
  return app;
}
