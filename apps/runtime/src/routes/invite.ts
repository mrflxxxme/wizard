// POST /api/admin/invite {role, email | phone} (runtime.yaml#auth.role_assignment (б)): only isAdmin roles;
// ≤ 20 invitations a day per system, Free — 5 (L3-29); the email invitation goes from the platform mail account.
// GET /_wizard/team — the admin's invitation page over this API (B2-16).
import { consumeInviteQuota, isConnectorError, isPlainAddress, sendPlatformEmail } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeHonoEnv } from "../http/context.js";
import { sessionOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { documentHeaders, escapeHtml, htmlPage } from "../preview/headers.js";
import { readObjectBody } from "../preview/http.js";

const PHONE_RE = /^\+79\d{9}$/;

export function inviteRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/invite", async (c) => {
    const { subject } = await sessionOf(c);
    if (subject.id === null) throw new WizardError("UNAUTHENTICATED");
    if (!subject.isAdmin) throw new WizardError("FORBIDDEN");
    const sys = c.get("system");
    const body = await readObjectBody(c);
    const role = sys.spec.roles.find((r) => r.name === body.role && r.access === "login");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
    const phone = typeof body.phone === "string" ? body.phone.trim() : undefined;
    const fields: { field: string; message: string }[] = [];
    if (!role) fields.push({ field: "role", message: "Роль не найдена" });
    if ((email === undefined) === (phone === undefined)) {
      fields.push({ field: "email", message: "Укажите email или телефон" });
    } else if (email !== undefined && !isPlainAddress(email)) {
      fields.push({ field: "email", message: "Некорректный адрес email" });
    } else if (phone !== undefined && !PHONE_RE.test(phone)) {
      fields.push({ field: "phone", message: "Телефон в формате +79XXXXXXXXX" });
    }
    if (!role || fields.length) throw new WizardError("VALIDATION_FAILED", { fields });
    const scheme = c.get("services").env.publicScheme;
    const ctx = host.platformMailCtx(sys, `${scheme}://${c.get("host")}`);
    try {
      await consumeInviteQuota(ctx);
    } catch (e) {
      if (isConnectorError(e) && e.code === "RATE_LIMITED") {
        throw new WizardError("RATE_LIMITED", { message: e.message });
      }
      throw e;
    }
    const inviter = subject.id;
    const id = await sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
      const rows = await tx.sql`
        insert into ${tx.sql(sys.schema)}.${tx.sql("users")} (role, email, phone, invited_by)
        values (${role.name}, ${email ?? null}, ${phone ?? null}, ${inviter})
        on conflict do nothing returning id`;
      return rows[0]?.id as string | undefined;
    });
    if (!id) throw new WizardError("CONFLICT", { message: "Пользователь с таким адресом уже есть" });
    let emailSent = false;
    if (email !== undefined) {
      try {
        await sendPlatformEmail(
          { ...ctx, idempotencyKey: `invite:${id}` },
          {
            to: email,
            subject: `Приглашение в «${sys.spec.app.name}»`,
            text: `Вас пригласили в систему «${sys.spec.app.name}». Чтобы войти, откройте ${scheme}://${c.get("host")}/login?role=${role.name}`,
            action: "invite",
          },
        );
        emailSent = true;
      } catch (e) {
        // The user exists either way; the admin sees emailSent: false and can share the link another way.
        if (!isConnectorError(e)) throw e;
      }
    }
    return c.json({ user: { id, role: role.name }, emailSent }, 201);
  });
  return app;
}

const INVITE_JS = `(function(){var f=document.getElementById("wz-team-form");if(!f)return;var out=document.getElementById("wz-team-result");f.addEventListener("submit",function(ev){ev.preventDefault();var c=f.elements.contact.value.trim();var b={role:f.elements.role.value};if(c.indexOf("@")>=0)b.email=c;else b.phone=c.replace(/[^0-9+]/g,"").replace(/^8(?=9[0-9]{9}$)/,"+7");out.textContent="Отправляем…";fetch("/api/admin/invite",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Wizard-Request":"1"},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){if(r.ok){out.textContent=j.emailSent?"Приглашение отправлено на почту. Сотрудник входит по коду.":"Сотрудник добавлен. Он входит по коду на этот телефон.";f.reset();return}var e=j&&j.error;var m=e&&e.fields&&e.fields.length?e.fields.map(function(x){return x.message}).join(". "):(e&&e.message)||"Не удалось пригласить";out.textContent=m},function(){out.textContent="Не удалось пригласить"})},function(){out.textContent="Нет связи с сервером"})})})();`;

/**
 * GET /_wizard/team (B2-16, module «Сотрудники и роли»): the page of an isAdmin user to invite a staff member into a
 * login role closed to self sign-up — a form over POST /api/admin/invite (generated system code cannot call it:
 * fetch is forbidden there by G0).
 */
export function invitePageRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/team", async (c) => {
    const s = await sessionOf(c).catch(() => null);
    const title = "Пригласить сотрудника";
    if (s?.subject.id == null) {
      const body = `<p><a href="/login?next=%2F_wizard%2Fteam">Войдите</a> как владелец системы.</p>`;
      return c.body(htmlPage(title, body), 200, documentHeaders("no-store"));
    }
    if (!s.subject.isAdmin) {
      const body = "<p>Нет доступа: приглашать сотрудников может только владелец системы.</p>";
      return c.body(htmlPage(title, body), 403, documentHeaders("no-store"));
    }
    const roles = c
      .get("system")
      .spec.roles.filter((r) => r.access === "login" && !r.isAdmin && !r.selfSignup);
    if (roles.length === 0) {
      const body = "<p>В системе нет ролей сотрудников: пригласить пока некого.</p>";
      return c.body(htmlPage(title, body), 200, documentHeaders("no-store"));
    }
    const options = roles
      .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.label)}</option>`)
      .join("");
    const body = [
      "<p>Сотрудник получит письмо со ссылкой и войдёт по коду. Если указать телефон, он входит по коду на телефон.</p>",
      '<form id="wz-team-form" data-testid="wz-team-form">',
      `<p><label>Роль <select name="role" data-testid="wz-team-role">${options}</select></label></p>`,
      '<p><label>Почта или телефон <input name="contact" required autocomplete="off" data-testid="wz-team-contact"></label></p>',
      '<p><button type="submit" data-testid="wz-team-submit">Пригласить</button></p>',
      "</form>",
      '<p id="wz-team-result" role="status" data-testid="wz-team-result"></p>',
    ].join("");
    return c.body(htmlPage(title, body, ["/_wizard/team.js"]), 200, documentHeaders("no-store"));
  });
  app.get("/team.js", (c) =>
    c.body(INVITE_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }),
  );
  return app;
}
