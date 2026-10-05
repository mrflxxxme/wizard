// /admin «Обращения» (D68, M2-57 mvp_scope): copies of «Написать команде» — who, organization, system, text, the
// reply deadline (overdue in red) and the «отвечено» mark. The founder answers by letter; there is no conversation here.
// Client text is rendered as text (React escapes it), never as HTML.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { SupportRequestItem } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill } from "../../components/ui.js";
import { support } from "../../i18n/ru/support.js";
import { ru } from "../../i18n/ru.js";
import s from "../../screens/admin/Admin.module.css";
import st from "../../screens/settings/Settings.module.css";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });

export function AdminSupport({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [items, setItems] = useState<SupportRequestItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .adminListSupportRequests(onlyOpen ? "open" : "all")
      .then((r) => live && setItems(r.items))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "MFA_REQUIRED") onMfaRequired();
        else setError(e instanceof Error ? e.message : ru.errors.generic);
      });
    return () => {
      live = false;
    };
  }, [api, onlyOpen, onMfaRequired]);

  async function mark(item: SupportRequestItem, answered: boolean) {
    setBusy(item.id);
    setError(null);
    try {
      const r = await api.adminMarkSupportRequest(item.id, answered);
      setItems((prev) =>
        (prev ?? [])
          .map((x) => (x.id === item.id ? { ...x, answeredAt: r.answeredAt } : x))
          .filter((x) => !onlyOpen || x.answeredAt === null),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : ru.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  const now = Date.now();
  return (
    <section className={st.block} data-testid="admin-support">
      <div className={st.head}>
        <h2 className={st.blockTitle}>{support.admin.tab}</h2>
        <span className={st.spacer} />
        <label className={st.check}>
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
            data-testid="admin-support-open"
          />
          {support.admin.onlyOpen}
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      {items?.length === 0 && <p className={st.muted}>{support.admin.empty}</p>}
      {items && items.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{support.admin.colWhen}</th>
                <th>{support.admin.colWho}</th>
                <th>{support.admin.colSystem}</th>
                <th>{support.admin.colText}</th>
                <th>{support.admin.colDue}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const late = x.answeredAt === null && new Date(x.replyBy).getTime() < now;
                return (
                  <tr key={x.id} data-testid="admin-support-row" data-id={x.id}>
                    <td>{fmt(x.createdAt)}</td>
                    <td>
                      {x.email ? <a href={`mailto:${x.email}`}>{x.email}</a> : "—"}
                      <br />
                      <span className={st.small}>{x.orgName}</span>
                    </td>
                    <td>
                      {x.systemId ? (
                        <a href={`/s/${x.systemId}`} target="_blank" rel="noopener noreferrer">
                          {x.systemName ?? x.systemId}
                        </a>
                      ) : (
                        <span className={st.muted}>{support.admin.noSystem}</span>
                      )}
                    </td>
                    <td className={st.preWrap} data-testid="admin-support-text">
                      {x.wantsTeam && (
                        <>
                          <Pill tone="accent">{support.admin.wantsTeam}</Pill>{" "}
                        </>
                      )}
                      {x.text}
                    </td>
                    <td className={late ? s.late : undefined}>
                      {fmt(x.replyBy)}
                      {late ? ` · ${support.admin.overdue}` : ""}
                    </td>
                    <td>
                      {x.answeredAt ? (
                        <>
                          <Pill tone="ok">{support.admin.answered}</Pill>{" "}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void mark(x, false)}
                          >
                            {support.admin.reopen}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === x.id}
                          disabled={busy !== null}
                          onClick={() => void mark(x, true)}
                          data-testid="admin-support-answered"
                        >
                          {support.admin.markAnswered}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
