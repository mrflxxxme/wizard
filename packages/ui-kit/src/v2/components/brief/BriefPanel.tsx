import {
  BRIEF_DIAGRAM_TITLES,
  BRIEF_FIELD_LABELS,
  BRIEF_FIELDS,
  type BriefDiagrams,
  type BriefField,
  type BriefVersion,
  type SystemBrief,
} from "@wizard/appspec";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import { ActionButton } from "../controls.js";
import { BriefDiagram } from "./BriefDiagram.js";
import { BriefDiffView } from "./BriefDiffView.js";
import { BRIEF_EDITABLE_SECTIONS, type BriefEditableSection, BriefEditor } from "./BriefEditor.js";
import s from "./BriefPanel.module.css";
import { BRIEF_DIAGRAM_KEYS, type BriefDiagramKey } from "./BriefSummary.js";
import { type BriefSession, SessionsFeed } from "./SessionsFeed.js";
import {
  ACTOR_RU,
  AUTHOR_RU,
  CHOSEN_RU,
  changedKeys,
  changesRu,
  dateRu,
  itemKey,
  LEVEL_RU,
  SOURCE_RU,
} from "./text.js";

/** A version in the history list: everything but the brief (GET /systems/:id/brief/versions). */
export type BriefVersionInfo = Omit<BriefVersion, "brief">;
export type BriefPanelTab = "brief" | "diagrams" | "versions" | "sessions";

export interface BriefPanelProps extends PBase {
  brief: SystemBrief;
  diagrams: BriefDiagrams;
  /** Version shown (the latest one). */
  version: number;
  author?: BriefVersion["author"];
  /** RFC 3339 time of the version. */
  createdAt?: string;
  /** History, newest first, with the diff of each version. */
  versions: readonly BriefVersionInfo[];
  /** Session feed of the system; adds the «Сессии» tab. */
  sessions?: readonly BriefSession[] | null;
  initialTab?: BriefPanelTab;
  /** Diagram to show first on «Схемы» (a thumbnail of the short brief was pressed). */
  initialDiagram?: BriefDiagramKey | null;
  /** The owner may edit: the editor saves through it (a new version, D77 (9)). */
  onSave?(brief: SystemBrief, baseVersion: number): void;
  saving?: boolean;
  saveError?: string | null;
  /** «Изменить словами»: back to the chat. */
  onAskInChat?(): void;
  onClose?(): void;
  /** A line above the tabs (e.g. «Бриф успели изменить — вот свежая версия»). */
  notice?: string | null;
}

const TAB_LABEL: Record<BriefPanelTab, string> = {
  brief: "Бриф",
  diagrams: "Схемы",
  versions: "Версии",
  sessions: "Сессии",
};

const DIRECTION_RU = {
  out: "система обращается к сервису",
  in: "сервис обращается к системе",
} as const;

type Mark = "added" | "changed" | undefined;

function Marked({ mark, children, testId }: { mark: Mark; children: ReactNode; testId?: string }): ReactNode {
  return (
    <li className={cx(s.item, mark && s.hl)} data-changed={mark} data-testid={testId}>
      {mark && <span className={s.badge}>{mark === "added" ? "новое" : "изменено"}</span>}
      {children}
    </li>
  );
}

function Section({
  field,
  count,
  whole,
  onEdit,
  children,
}: {
  field: BriefField;
  count?: number;
  whole: boolean;
  onEdit?: () => void;
  children: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <section
      className={cx(s.section, whole && s.hlSection)}
      aria-labelledby={id}
      data-testid={`p-brief-section-${field}`}
      data-changed={whole || undefined}
    >
      <div className={s.sectionHead}>
        <h3 id={id} className={s.sectionTitle}>
          {BRIEF_FIELD_LABELS[field]}
          {count !== undefined && count > 0 && <span className={s.count}>{count}</span>}
          {whole && <span className={s.badge}>изменено</span>}
        </h3>
        {onEdit && (
          <ActionButton
            size="sm"
            variant="ghost"
            testId={`p-brief-edit-${field}`}
            aria-label={`Изменить: ${BRIEF_FIELD_LABELS[field]}`}
            onClick={onEdit}
          >
            Изменить
          </ActionButton>
        )}
      </div>
      {children}
    </section>
  );
}

const Empty = () => <p className={s.empty}>Пока пусто</p>;

/**
 * The «Бриф» panel (D77 (9)): the whole brief by sections with what the latest version changed highlighted, the three
 * diagrams, the versions with their difference and the session feed; the owner edits sections here (a new version) or
 * goes back to the chat to say it in words. Tabs follow the WAI-ARIA pattern (arrows, Home, End).
 */
export function BriefPanel({
  brief,
  diagrams,
  version,
  author,
  createdAt,
  versions,
  sessions = null,
  initialTab = "brief",
  initialDiagram = null,
  onSave,
  saving = false,
  saveError = null,
  onAskInChat,
  onClose,
  notice = null,
  className,
  testId,
}: BriefPanelProps): ReactNode {
  const base = useId();
  const tabs: BriefPanelTab[] = sessions
    ? ["brief", "diagrams", "versions", "sessions"]
    : ["brief", "diagrams", "versions"];
  const [tab, setTab] = useState<BriefPanelTab>(tabs.includes(initialTab) ? initialTab : "brief");
  const [editing, setEditing] = useState<BriefEditableSection | null>(null);
  const [selected, setSelected] = useState<number>(version);
  const tabRefs = useRef(new Map<BriefPanelTab, HTMLButtonElement>());
  const diagramRefs = useRef(new Map<BriefDiagramKey, HTMLElement>());
  // A new version (saved here or by the chat) closes the editor and becomes the selected version.
  useEffect(() => {
    setEditing(null);
    setSelected(version);
  }, [version]);
  useEffect(() => {
    if (tab === "diagrams" && initialDiagram)
      diagramRefs.current.get(initialDiagram)?.scrollIntoView?.({ block: "start" });
  }, [tab, initialDiagram]);

  const current = versions.find((v) => v.version === version);
  const marks = useMemo(() => changedKeys(version > 1 ? (current?.diff ?? []) : []), [current, version]);
  const mark = (field: BriefField, item: unknown): Mark => marks.items.get(field)?.get(itemKey(field, item));
  const editable = (f: BriefField): f is BriefEditableSection =>
    !!onSave && (BRIEF_EDITABLE_SECTIONS as readonly string[]).includes(f);
  const goalText = new Map(brief.goals.map((g) => [g.id, g.text]));
  const chosen = versions.find((v) => v.version === selected) ?? versions[0];

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = tabs.indexOf(tab);
    const to =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs[tabs.length - 1]
              : undefined;
    if (!to) return;
    e.preventDefault();
    setTab(to);
    tabRefs.current.get(to)?.focus();
  }

  function body(field: BriefField): ReactNode {
    switch (field) {
      case "goals":
        return brief.goals.length ? (
          <ul className={s.list}>
            {brief.goals.map((g) => (
              <Marked key={g.id} mark={mark("goals", g)} testId="p-brief-item">
                <b>{g.text}</b>
                <span className={s.sub}>Признак успеха: {g.success}</span>
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
      case "audience":
        return brief.audience ? <p className={s.text}>{brief.audience}</p> : <Empty />;
      case "scenarios":
        return brief.scenarios.length ? (
          <ol className={s.list}>
            {brief.scenarios.map((x) => (
              <Marked key={x.id} mark={mark("scenarios", x)} testId="p-brief-item">
                <span className={s.tags}>
                  <span className={s.tag}>{ACTOR_RU[x.actor]}</span>
                  <span className={cx(s.tag, x.priority === "must" && s.must)}>
                    {x.priority === "must" ? "обязательно" : "желательно"}
                  </span>
                </span>
                <span>
                  <b>Когда {x.when}</b>, система:
                </span>
                <ul className={s.steps}>
                  {x.then.map((t, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps of one scenario
                    <li key={i}>{t}</li>
                  ))}
                </ul>
                {x.goalId && goalText.get(x.goalId) && (
                  <span className={s.sub}>Цель: {goalText.get(x.goalId)}</span>
                )}
              </Marked>
            ))}
          </ol>
        ) : (
          <Empty />
        );
      case "roles":
        return brief.roles.length ? (
          <ul className={s.list}>
            {brief.roles.map((r) => (
              <Marked key={r.id} mark={mark("roles", r)} testId="p-brief-item">
                <b>{r.name}</b>
                <span className={s.sub}>{r.can.length ? r.can.join("; ") : "доступы не указаны"}</span>
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
      case "data":
        return brief.data.length ? (
          <ul className={s.list}>
            {brief.data.map((d) => (
              <Marked key={d.entity} mark={mark("data", d)} testId="p-brief-item">
                <b>{d.entity}</b>
                {d.fields.length > 0 && (
                  <span className={s.sub}>
                    Поля:{" "}
                    {d.fields.map((f, i) => (
                      <span key={f.name}>
                        {i > 0 && ", "}
                        {f.name}
                        {f.pii && <span className={s.pii}> (персональные данные)</span>}
                      </span>
                    ))}
                  </span>
                )}
                <span className={s.sub}>Храним: {d.retention}</span>
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
      case "integrations":
        return brief.integrations.length ? (
          <ul className={s.list}>
            {brief.integrations.map((x) => (
              <Marked key={x.id} mark={mark("integrations", x)} testId="p-brief-item">
                <b>{x.name}</b>
                <span className={s.sub}>
                  {DIRECTION_RU[x.direction]} ·{" "}
                  {x.contractRef ? "контракт API описан" : "контракт API не описан"}
                  {x.direction === "out" &&
                    (x.secretRef ? " · ключ подключён" : " · ключа нет — работает на заглушке")}
                </span>
              </Marked>
            ))}
          </ul>
        ) : (
          <p className={s.empty}>Связей с другими сервисами нет</p>
        );
      case "design":
        return brief.design.archetype || brief.design.references.length ? (
          <div className={s.text}>
            {brief.design.archetype && (
              <p>
                Направление: <b>{brief.design.archetype}</b>
                {brief.design.pinned ? " — выбрано вами" : ""}
              </p>
            )}
            {brief.design.references.length > 0 && (
              <ul className={s.refs}>
                {brief.design.references.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className={s.empty}>Направление выберем после интервью</p>
        );
      case "outOfScope":
        return brief.outOfScope.length ? (
          <ul className={s.list}>
            {brief.outOfScope.map((o) => (
              <Marked key={o.text} mark={mark("outOfScope", o)} testId="p-brief-item">
                <b>{o.text}</b>
                {o.substitute && <span className={s.sub}>Вместо этого: {o.substitute}</span>}
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
      case "assumptions":
        return brief.assumptions.length ? (
          <ul className={s.list}>
            {brief.assumptions.map((a) => (
              <Marked key={a.text} mark={mark("assumptions", a)} testId="p-brief-item">
                <span>{a.text}</span>
                <span className={s.sub}>{SOURCE_RU[a.source]}</span>
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
      case "qa":
        return brief.qa.length ? (
          <ol className={s.list}>
            {brief.qa.map((q) => (
              <Marked key={q.q} mark={mark("qa", q)} testId="p-brief-item">
                <b>{q.q}</b>
                <span>{q.a}</span>
                <span className={s.sub}>
                  {CHOSEN_RU[q.chosen]}
                  {q.recommended && q.chosen !== "recommended" ? ` · советовали: ${q.recommended}` : ""}
                </span>
              </Marked>
            ))}
          </ol>
        ) : (
          <Empty />
        );
      case "capability":
        return brief.capability.length ? (
          <ul className={s.list}>
            {brief.capability.map((c) => (
              <Marked key={c.requirement} mark={mark("capability", c)} testId="p-brief-item">
                <b>{c.requirement}</b>
                <span className={cx(s.sub, c.level === "not_yet" && s.notYet)}>{LEVEL_RU[c.level]}</span>
              </Marked>
            ))}
          </ul>
        ) : (
          <Empty />
        );
    }
  }

  const count = (f: BriefField): number | undefined => {
    const v = brief[f];
    return Array.isArray(v) ? v.length : undefined;
  };
  const latestDiff = version > 1 ? (current?.diff ?? []) : [];
  const meta = [`Версия ${version}`, dateRu(createdAt), author ? AUTHOR_RU[author] : ""].filter(Boolean);

  return (
    <section
      {...pRoot("BriefPanel", testId, "p-brief-panel")}
      aria-labelledby={`${base}-title`}
      className={cx(s.panel, className)}
    >
      <header className={s.head}>
        <div className={s.headText}>
          <h2 id={`${base}-title`} className={s.title}>
            Бриф системы
          </h2>
          <p className={s.meta} data-testid="p-brief-panel-version">
            {meta.join(" · ")}
          </p>
        </div>
        {onAskInChat && (
          <ActionButton size="sm" className={s.ask} testId="p-brief-ask" onClick={onAskInChat}>
            Изменить словами
          </ActionButton>
        )}
        {onClose && (
          <button
            type="button"
            className={s.close}
            aria-label="Закрыть бриф"
            data-testid="p-brief-close"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </header>
      {notice && (
        <p className={s.notice} role="status" data-testid="p-brief-notice">
          {notice}
        </p>
      )}
      <div className={s.tabs} role="tablist" aria-label="Разделы брифа">
        {tabs.map((t) => (
          <button
            key={t}
            ref={(el) => {
              if (el) tabRefs.current.set(t, el);
              else tabRefs.current.delete(t);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`${base}-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={s.tab}
            data-testid={`p-brief-tab-${t}`}
            onClick={() => setTab(t)}
            onKeyDown={onTabKey}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div
        className={s.body}
        role="tabpanel"
        id={`${base}-panel-${tab}`}
        aria-labelledby={`${base}-tab-${tab}`}
        data-testid={`p-brief-body-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tab panel takes focus (WAI-ARIA tabs pattern)
        tabIndex={0}
      >
        {tab === "brief" &&
          (editing && onSave ? (
            <BriefEditor
              brief={brief}
              baseVersion={version}
              section={editing}
              busy={saving}
              error={saveError}
              onSave={onSave}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              {latestDiff.length > 0 && (
                <div className={s.news} data-testid="p-brief-news">
                  <p className={s.newsTitle}>
                    В версии {version} — {changesRu(latestDiff.length)}
                  </p>
                  <ul>
                    {latestDiff.slice(0, 3).map((c, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a stored diff never reorders
                      <li key={i}>{c.text_ru}</li>
                    ))}
                  </ul>
                  <ActionButton
                    size="sm"
                    variant="ghost"
                    testId="p-brief-news-all"
                    onClick={() => {
                      setSelected(version);
                      setTab("versions");
                    }}
                  >
                    Показать разницу
                  </ActionButton>
                </div>
              )}
              {BRIEF_FIELDS.map((f) => (
                <Section
                  key={f}
                  field={f}
                  count={count(f)}
                  whole={marks.whole.has(f)}
                  {...(editable(f) ? { onEdit: () => setEditing(f) } : {})}
                >
                  {body(f)}
                </Section>
              ))}
            </>
          ))}
        {tab === "diagrams" &&
          BRIEF_DIAGRAM_KEYS.map((k) => (
            <div
              key={k}
              ref={(el) => {
                if (el) diagramRefs.current.set(k, el);
                else diagramRefs.current.delete(k);
              }}
              className={s.diagram}
            >
              <BriefDiagram
                graph={diagrams[k]}
                title={BRIEF_DIAGRAM_TITLES[k]}
                testId={`p-brief-diagram-${k}`}
              />
            </div>
          ))}
        {tab === "versions" && (
          <div className={s.versions}>
            <ol className={s.vlist} aria-label="Версии брифа">
              {versions.map((v) => (
                <li key={v.version}>
                  <button
                    type="button"
                    className={s.vbtn}
                    aria-current={chosen?.version === v.version || undefined}
                    data-testid={`p-brief-version-${v.version}`}
                    onClick={() => setSelected(v.version)}
                  >
                    <b>Версия {v.version}</b>
                    <span>
                      {[AUTHOR_RU[v.author], dateRu(v.createdAt), changesRu(v.diff.length)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {chosen ? (
              <BriefDiffView
                changes={chosen.diff}
                version={chosen.version}
                author={chosen.author}
                createdAt={chosen.createdAt}
              />
            ) : (
              <p className={s.empty}>Версий пока нет</p>
            )}
          </div>
        )}
        {tab === "sessions" && sessions && (
          <SessionsFeed
            sessions={sessions}
            onOpenVersion={(v) => {
              setSelected(v);
              setTab("versions");
            }}
          />
        )}
      </div>
    </section>
  );
}
