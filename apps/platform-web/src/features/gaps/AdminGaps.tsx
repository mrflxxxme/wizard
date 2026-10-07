// /admin «Запросы на развитие» (D73, M2-59 mvp_scope): categories by frequency (7 and 30 days, all time, systems) and
// the latest requests with the client's quote (already without personal data), the offered substitute, a link to the
// system and the client's address. A category filters the list. Quotes are rendered as text, never as HTML.
import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { DevelopmentCategory, DevelopmentRequests } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Alert, Pill } from "../../components/ui.js";
import { gaps } from "../../i18n/ru/gaps.js";
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
const label = (c: string) => gaps.category[c] ?? c;

export function AdminGaps({ onMfaRequired }: { onMfaRequired(): void }): ReactNode {
  const { api } = usePlatform();
  const [category, setCategory] = useState<DevelopmentCategory | "">("");
  const [data, setData] = useState<DevelopmentRequests | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .adminDevelopmentRequests(category || undefined)
      .then((r) => live && setData(r))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "MFA_REQUIRED") onMfaRequired();
        else setError(e instanceof Error ? e.message : ru.errors.generic);
      });
    return () => {
      live = false;
    };
  }, [api, category, onMfaRequired]);

  return (
    <section className={st.block} data-testid="admin-gaps">
      <h2 className={st.blockTitle}>{gaps.tab}</h2>
      <p className={st.hint}>{gaps.lead}</p>
      {error && <Alert>{error}</Alert>}
      {data && data.categories.length === 0 && <p className={st.muted}>{gaps.empty}</p>}
      {data && data.categories.length > 0 && (
        <>
          <h3 className={st.subTitle}>{gaps.categoriesTitle}</h3>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{gaps.colCategory}</th>
                  <th>{gaps.col7}</th>
                  <th>{gaps.col30}</th>
                  <th>{gaps.colTotal}</th>
                  <th>{gaps.colSystems}</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.category} data-testid="admin-gaps-category" data-category={c.category}>
                    <td>
                      <button
                        type="button"
                        className={st.link}
                        aria-pressed={category === c.category}
                        onClick={() => setCategory(category === c.category ? "" : c.category)}
                      >
                        {label(c.category)}
                      </button>
                    </td>
                    <td>{c.last7}</td>
                    <td>{c.last30}</td>
                    <td>{c.total}</td>
                    <td>{c.systems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={st.head}>
            <h3 className={st.subTitle}>
              {gaps.latest}
              {category ? ` · ${label(category)}` : ""}
            </h3>
            {category && (
              <button type="button" className={st.link} onClick={() => setCategory("")}>
                {gaps.all}
              </button>
            )}
          </div>
          <ul className={st.list}>
            {data.items.map((x) => (
              <li
                key={x.id}
                data-testid="admin-gaps-item"
                data-category={x.category}
                data-status={x.status ?? "open"}
              >
                <span className={st.small}>
                  {x.status === "done" && (
                    <>
                      <Pill tone="ok" testId="admin-gaps-done">
                        {gaps.done}
                      </Pill>{" "}
                    </>
                  )}
                  {fmt(x.createdAt)} · {label(x.category)} · {x.orgName}
                  {x.email ? (
                    <>
                      {" · "}
                      <a href={`mailto:${x.email}`}>{x.email}</a>
                    </>
                  ) : null}
                  {" · "}
                  {x.systemId ? (
                    <a href={`/s/${x.systemId}`} target="_blank" rel="noopener noreferrer">
                      {x.systemName ?? x.systemId}
                    </a>
                  ) : (
                    gaps.noSystem
                  )}
                </span>
                <br />
                <b>{gaps.quote}:</b> <span data-testid="admin-gaps-quote">{x.quote}</span>
                <br />
                <b>{gaps.offered}:</b> {x.offered ?? gaps.noOffer}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
