// POST /api/admin/invite {role, email | phone} (runtime.yaml#auth.role_assignment (б)): only isAdmin roles;
// ≤ 20 invitations a day per system, Free — 5 (L3-29); the email invitation goes from the platform mail account.
import { consumeInviteQuota, isConnectorError, isPlainAddress, sendPlatformEmail } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeHonoEnv } from "../http/context.js";
import { sessionOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
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
