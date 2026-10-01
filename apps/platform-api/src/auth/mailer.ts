// Platform mail (OTP codes, invites, notices, billing, founder alerts). With WIZARD_SMTP_HOST letters go over SMTP
// (auth/smtp-mailer.ts, M2-09); otherwise — locally and in tests — to files in .data/outbox/platform.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MailMessage {
  /**
   * notice — events for the owner of a system (consent withdrawal, compliance.yaml#consent.withdrawal); alert — founder
   * alerts (ops/alert.ts, WIZARD_OPS_ALERT_EMAIL).
   */
  kind: "otp" | "invite" | "notice" | "billing" | "alert";
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

export interface OutboxLetter extends MailMessage {
  createdAt: string;
}

/** Writes each letter as a JSON file; `list()` reads them back (local login, tests). */
export class OutboxMailer implements Mailer {
  constructor(readonly dir: string) {}

  async send(m: MailMessage): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
    const letter: OutboxLetter = { ...m, createdAt: new Date().toISOString() };
    writeFileSync(join(this.dir, name), `${JSON.stringify(letter, null, 2)}\n`, { mode: 0o600 });
  }

  /** Letters, oldest first (optionally to one address). */
  list(to?: string): OutboxLetter[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .sort()
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), "utf8")) as OutboxLetter)
      .filter((l) => to === undefined || l.to === to);
  }
}
