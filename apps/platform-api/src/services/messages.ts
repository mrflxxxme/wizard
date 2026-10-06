import { json } from "../db/index.js";
import type { TxCtx } from "../runs/events.js";

export interface NewMessage {
  systemId: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "questions" | "answers" | "card" | "run_report" | "notice" | "plan";
  text?: string | null;
  payload?: Record<string, unknown> | null;
  runId?: string | null;
  authorUserId?: string | null;
}

/** Caller MUST hold the systems row lock (seq = max+1 per system). */
export async function insertMessage(t: TxCtx, m: NewMessage) {
  const { next } = await t.trx
    .selectFrom("platform.messages")
    .select((eb) => eb.fn.coalesce(eb.fn.max("seq"), eb.lit(0)).as("next"))
    .where("system_id", "=", m.systemId)
    .executeTakeFirstOrThrow();
  return t.trx
    .insertInto("platform.messages")
    .values({
      system_id: m.systemId,
      seq: Number(next) + 1,
      role: m.role,
      kind: m.kind,
      text: m.text ?? null,
      payload: m.payload ? json(m.payload) : null,
      run_id: m.runId ?? null,
      author_user_id: m.authorUserId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
