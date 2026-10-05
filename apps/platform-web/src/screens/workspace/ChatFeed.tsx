// Chat messages of GET /systems/:id (S2–S6) and the PII notice (platform-screens.yaml#pii_notice).
// LLM text is rendered as plain text only (L3-17).
import type { ReactNode } from "react";
import type { Message } from "../../api/types.js";
import { Note } from "../../components/ui.js";
import { TeamButton } from "../../features/support/SupportWidget.js";
import { support } from "../../i18n/ru/support.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

function piiText(m: Message, ruOnly: boolean): string {
  const cats = Array.isArray(m.payload?.categories) ? (m.payload.categories as unknown[]) : [];
  const words = [
    ...new Set(
      cats.filter((c): c is string => typeof c === "string").map((c) => ru.chat.piiCategory[c] ?? c),
    ),
  ];
  const text = ru.chat.piiNotice(words.join(", "));
  return ruOnly ? `${text} ${ru.chat.piiRuOnly}` : text;
}

function messageText(m: Message): string {
  if (m.role === "user") {
    const masked = m.payload?.maskedText;
    return typeof masked === "string" ? masked : (m.text ?? "");
  }
  if (m.kind === "card" && !m.text) {
    const v = m.payload?.cardVersion;
    return ru.chat.cardMessage(typeof v === "number" ? v : 1);
  }
  return m.text ?? "";
}

/** M3-01: «AppShell · ui/Landing.tsx» of a point-edit request (messages.payload.target), as text. */
function targetLabel(m: Message): string | null {
  const t = m.role === "user" ? m.payload?.target : undefined;
  if (!t || typeof t !== "object") return null;
  const { componentName, file } = t as { componentName?: unknown; file?: unknown };
  if (typeof file !== "string") return null;
  return ru.point.sent(typeof componentName === "string" ? componentName : "");
}

/** M2-77/D73: «Пока не умеем» of the orchestrator (payload.gaps) → «Написать команде» with the request pre-filled. */
function gapsOf(m: Message): string[] {
  const g = m.role === "assistant" ? m.payload?.gaps : undefined;
  if (!Array.isArray(g)) return [];
  return g
    .map((x) => (x && typeof x === "object" ? (x as { missing?: unknown }).missing : undefined))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

function author(m: Message): string {
  if (m.role === "user") return ru.chat.you;
  if (m.role === "system") return ru.chat.system;
  return ru.chat.agents.orchestrator ?? "";
}

export function ChatFeed({ messages, ruOnly = false }: { messages: Message[]; ruOnly?: boolean }): ReactNode {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const firstNotice = sorted.find((m) => m.kind === "notice" && m.payload?.type === "pii");
  return (
    <ol className={s.feed} aria-live="polite">
      {sorted.map((m) => {
        if (m.kind === "notice") {
          // One PII notice per session (orchestrator.yaml#pii_notice.rules), never the values.
          if (m !== firstNotice) return null;
          return (
            <li key={m.id}>
              <Note testId="chat-pii-notice">{piiText(m, ruOnly)}</Note>
            </li>
          );
        }
        const text = messageText(m);
        if (!text) return null;
        return (
          <li key={m.id} className={m.role === "user" ? s.bubbleUser : s.bubble} data-testid="chat-message">
            <span className={s.bubbleAuthor}>{author(m)}</span>
            {targetLabel(m) && (
              <span className={s.bubbleTarget} data-testid="chat-message-target">
                {targetLabel(m)}
              </span>
            )}
            <span className={s.bubbleText}>{text}</span>
            {gapsOf(m).length > 0 && (
              <span>
                <TeamButton testId="chat-gap-team" wantsTeam text={support.gapText(gapsOf(m))} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
