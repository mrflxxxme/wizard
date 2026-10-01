// Staff moderation CLI with direct DB access (WIZARD_DB_URL / DATABASE_URL), like the credits CLI. Founder reviews also
// have the admin console /admin (api.yaml#adminFounderReview, staff with MFA — M2-08); staff accounts are granted here.
// Usage:
//   pnpm --filter @wizard/platform-api moderation reviews
//   pnpm --filter @wizard/platform-api moderation approve <systemId> <revision> [note…]
//   pnpm --filter @wizard/platform-api moderation reject <systemId> <revision> <note…>
//   pnpm --filter @wizard/platform-api moderation staff <email>            — staff account (MFA enrolment on first /admin)
//   pnpm --filter @wizard/platform-api moderation staff-revoke <email>
//   pnpm --filter @wizard/platform-api moderation staff-reset-mfa <email>  — lost authenticator: enrol again
import { resetStaffMfa, setStaff } from "../abuse/staff.js";
import { platformMailer } from "../auth/smtp-mailer.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { SecretStore } from "../secrets/store.js";
import { decideFounderReview, pendingFounderReviews } from "./moderation.js";

async function main(argv: string[]): Promise<string> {
  const [cmd, systemId = "", rev = "", ...rest] = argv;
  const config = loadConfig();
  const h = createDb(config.dbUrl, 2);
  try {
    if (cmd === "staff" || cmd === "staff-revoke") {
      if (!systemId.includes("@")) throw new Error(`${cmd} <email>`);
      await setStaff(h.db, systemId, cmd === "staff");
      return cmd === "staff" ? "staff назначен; MFA подключается при первом входе в /admin" : "staff снят";
    }
    if (cmd === "staff-reset-mfa") {
      if (!systemId.includes("@")) throw new Error(`${cmd} <email>`);
      await resetStaffMfa(h.db, new SecretStore(config.secretsFile, config.secretsKey), systemId);
      return "MFA сброшена; подключите приложение заново при входе в /admin";
    }
    if (cmd === "reviews") return JSON.stringify(await pendingFounderReviews(h.db), null, 2);
    if (cmd === "approve" || cmd === "reject") {
      const revision = Number(rev);
      const note = rest.join(" ").trim();
      if (!systemId || !Number.isInteger(revision) || (cmd === "reject" && note.length < 3))
        throw new Error(`${cmd} <systemId> <revision> ${cmd === "reject" ? "<note…>" : "[note…]"}`);
      const ok = await decideFounderReview(
        h.db,
        { systemId, revision, decision: cmd, ...(note ? { note } : {}) },
        { mailer: platformMailer(config), platformOrigin: config.platformOrigin },
      );
      if (!ok) throw new Error("ревизия не ждёт ревью");
      return cmd === "approve"
        ? "одобрено, владельцу отправлено письмо"
        : "отклонено, владельцу отправлено письмо";
    }
    throw new Error("команды: reviews | approve | reject | staff | staff-revoke | staff-reset-mfa");
  } finally {
    await h.close();
  }
}

main(process.argv.slice(2)).then(
  (out) => process.stdout.write(`${out}\n`),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
