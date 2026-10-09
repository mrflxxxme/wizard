// Client cabinet «tabs»: the heading of the page and who is signed in, the kinds of the visitor's records as tabs
// («Мои записи», «Мои заявки»), the records of the open tab as rows — the fields as label and value, the status, and
// «Отменить» with a confirmation where the role may cancel. A guest gets the sign-in by a code. The data is the
// module's: useMyRecords (C4) gives only the visitor's own records (the server's rowFilter), newest first. Own
// composition.
import { type MyRecordsModel, useClientSession, useMyRecords } from "@wizard/ui-kit/v3/headless";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type Section = {
  id: string;
  entity: string;
  label: string;
  fields?: string[];
  cancel?: { field: string; value: string; label: string };
  empty: string;
};

export type AccountTabsProps = {
  /** «Личный кабинет». */
  title: string;
  text?: string;
  /** 1 — the heading of the page (default), 2 — under a first screen. */
  level?: 1 | 2;
  /** Kinds of the visitor's records, each with its entity, fields and cancel. */
  sections: Section[];
  /** Sign-in of a guest: the login page with the way back. */
  signIn: Link;
  /** The action of an empty cabinet (to book, to leave a request). */
  action?: Link;
  /** What a cabinet without sections says. */
  empty?: string;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const secondaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const tabClass =
  "inline-flex min-h-11 shrink-0 items-center border-b-2 px-4 text-body font-bold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The heading of the cabinet at the level of the props (the page's h1 by default). */
function Heading({ level, id, children }: { level: 1 | 2; id: string; children: ReactNode }) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag
      id={id}
      className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
    >
      {children}
    </Tag>
  );
}

/** A guest: why he sees nothing and how to sign in (a code by e-mail or SMS). */
function SignIn({ signIn }: { signIn: Link }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-8">
      <p className="text-lead font-bold">Войдите, чтобы увидеть свои записи и заявки</p>
      <p className="mt-2 max-w-text text-body text-muted-foreground">
        Пришлём код на почту или телефон, которые вы указали при записи или в заявке.
      </p>
      <a href={signIn.href} className={`mt-6 ${primaryClass}`}>
        {signIn.label}
      </a>
    </div>
  );
}

/** Loading of the records: the outline of the rows, announced once. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем ваши записи…</span>
      <div aria-hidden="true" className="grid gap-3">
        {["a", "b", "c"].map((k) => (
          <div key={k} className="h-20 rounded-md bg-muted" />
        ))}
      </div>
    </div>
  );
}

/** One record: its fields as label and value, the status, «Отменить» with a confirmation. */
function Row({
  m,
  item,
  cancel,
}: {
  m: MyRecordsModel;
  item: MyRecordsModel["items"][number];
  cancel?: Section["cancel"];
}) {
  const [asking, setAsking] = useState(false);
  const busy = m.pending === item.id;
  const cells = item.cells.filter((c) => c.text !== item.status);
  return (
    <li data-testid="wz-datatable-row" className="py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <dl className="grid min-w-0 flex-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {cells.map((c) => (
            <div key={c.name} className="min-w-0">
              <dt className="text-small text-muted-foreground">{c.label}</dt>
              <dd className="text-body font-bold wrap-break-word">{c.text}</dd>
            </div>
          ))}
        </dl>
        {item.status ? (
          <p className="shrink-0">
            <span className="inline-flex min-h-8 items-center rounded-control border border-border px-3 text-small font-bold">
              {item.status}
            </span>
          </p>
        ) : null}
      </div>
      {cancel && item.canCancel ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {asking ? (
            <>
              <p className="text-body font-bold">{`${cancel.label}?`}</p>
              <button
                type="button"
                aria-disabled={busy ? true : undefined}
                onClick={() => {
                  if (busy) return;
                  void m.cancel(item.id).then(() => setAsking(false));
                }}
                className={primaryClass}
              >
                {busy ? "Отменяем…" : "Да, отменить"}
              </button>
              <button type="button" onClick={() => setAsking(false)} className={secondaryClass}>
                Нет
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setAsking(true)} className={secondaryClass}>
              {cancel.label}
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** The records of one kind: loading, a load error, empty, the rows and «Показать ещё». */
function Records({ section, action }: { section: Section; action?: Link }) {
  const m = useMyRecords(section.entity, {
    ...(section.fields ? { fields: section.fields } : {}),
    ...(section.cancel ? { cancel: { field: section.cancel.field, value: section.cancel.value } } : {}),
  });
  if (m.error && m.items.length === 0)
    return (
      <div role="alert" className="rounded-lg border border-border p-6 sm:p-8">
        <p className="text-body font-bold">Не получилось загрузить ваши записи.</p>
        <p className="mt-1 text-body text-muted-foreground">Обновите страницу чуть позже.</p>
      </div>
    );
  if (m.isLoading && m.items.length === 0) return <Loading />;
  if (m.items.length === 0)
    return (
      <div className="rounded-lg border border-border p-6 sm:p-8">
        <p data-testid="wz-empty" className="text-body text-muted-foreground">
          {section.empty}
        </p>
        {action ? (
          <a href={action.href} className={`mt-5 ${secondaryClass}`}>
            {action.label}
          </a>
        ) : null}
      </div>
    );
  return (
    <>
      {m.cancelError ? (
        <p role="alert" className="mb-4 text-body font-bold">
          {m.cancelError}
        </p>
      ) : null}
      <ul className="divide-y divide-border border-y border-border">
        {m.items.map((item) => (
          <Row key={item.id} m={m} item={item} {...(section.cancel ? { cancel: section.cancel } : {})} />
        ))}
      </ul>
      {m.hasMore ? (
        <div className="mt-8 flex justify-center">
          <button type="button" onClick={m.more} className={secondaryClass}>
            Показать ещё
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function AccountTabs(props: AccountTabsProps) {
  const { title, text, sections, signIn, action, empty } = props;
  const level = props.level ?? 1;
  const uid = useId();
  const session = useClientSession();
  const [open, setOpen] = useState(sections[0]?.id ?? "");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = sections.find((s) => s.id === open) ?? sections[0];
  // Arrow keys move along the tabs (WAI-ARIA tabs), Home and End to the ends.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = sections.findIndex((s) => s.id === current?.id);
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % sections.length
        : e.key === "ArrowLeft"
          ? (i - 1 + sections.length) % sections.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? sections.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = sections[to];
    if (!next) return;
    setOpen(next.id);
    tabs.current[to]?.focus();
  };
  let body: ReactNode;
  if (session.isLoading) body = <Loading />;
  else if (!session.signedIn) body = <SignIn signIn={signIn} />;
  else if (!current)
    body = (
      <p data-testid="wz-empty" className="text-body text-muted-foreground">
        {empty ?? "Здесь появятся ваши записи и заявки"}
      </p>
    );
  else
    body = (
      <>
        {sections.length > 1 ? (
          <div
            role="tablist"
            aria-label="Разделы кабинета"
            onKeyDown={onKey}
            className="flex gap-2 overflow-x-auto border-b border-border"
          >
            {sections.map((s, i) => {
              const on = s.id === current.id;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${uid}-tab-${s.id}`}
                  aria-selected={on}
                  aria-controls={`${uid}-panel`}
                  tabIndex={on ? 0 : -1}
                  data-testid={`wz-cabinet-tab-${s.id}`}
                  onClick={() => setOpen(s.id)}
                  className={`${tabClass} ${on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        ) : (
          <h2 className="font-display text-h3 font-bold">{current.label}</h2>
        )}
        {sections.length > 1 ? (
          <div
            id={`${uid}-panel`}
            role="tabpanel"
            aria-labelledby={`${uid}-tab-${current.id}`}
            className="mt-6"
          >
            <Records key={current.id} section={current} {...(action ? { action } : {})} />
          </div>
        ) : (
          <div className="mt-6">
            <Records key={current.id} section={current} {...(action ? { action } : {})} />
          </div>
        )}
      </>
    );
  return (
    <section
      data-wz-component="ClientCabinet"
      data-wz-id={props.wzId}
      aria-labelledby={`${uid}-title`}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-text min-w-0">
            <Heading level={level} id={`${uid}-title`}>
              {title}
            </Heading>
            {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
          </div>
          {session.signedIn ? (
            <div className="flex flex-wrap items-center gap-3">
              {session.name ? (
                <p className="text-small text-muted-foreground">{`Вы вошли как ${session.name}`}</p>
              ) : null}
              <button type="button" onClick={() => void session.signOut()} className={secondaryClass}>
                Выйти
              </button>
            </div>
          ) : null}
        </div>
        <div className="mt-10">{body}</div>
      </div>
    </section>
  );
}
