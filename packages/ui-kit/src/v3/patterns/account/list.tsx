// Client cabinet «list»: the heading of the page and who is signed in, then every kind of the visitor's records one
// under another («Мои записи», «Мои заявки») — each record a card with its fields, the status and «Отменить» with a
// confirmation where the role may cancel. A guest gets the sign-in by a code. The data is the module's: useMyRecords
// (C4) gives only the visitor's own records (the server's rowFilter), newest first. Own composition.
import { type MyRecordsModel, useClientSession, useMyRecords } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useState } from "react";

type Link = { label: string; href: string };
type Section = {
  id: string;
  entity: string;
  label: string;
  fields?: string[];
  cancel?: { field: string; value: string; label: string };
  empty: string;
};

export type AccountListProps = {
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

/** A guest: why he sees nothing and how to sign in (a code by e-mail or SMS). */
function SignIn({ signIn }: { signIn: Link }) {
  return (
    <div className="max-w-text">
      <p className="text-lead font-bold">Войдите, чтобы увидеть свои записи и заявки</p>
      <p className="mt-2 text-body text-muted-foreground">
        Пришлём код на почту или телефон, которые вы указали при записи или в заявке.
      </p>
      <a href={signIn.href} className={`mt-6 ${primaryClass}`}>
        {signIn.label}
      </a>
    </div>
  );
}

/** Loading of the records: the outline of the cards, announced once. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем ваши записи…</span>
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2">
        {["a", "b"].map((k) => (
          <div key={k} className="h-32 rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}

/** One record as a card: the status on top, the fields as label and value, «Отменить» with a confirmation. */
function Card({
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
    <li
      data-testid="wz-datatable-row"
      className="min-w-0 rounded-lg border border-border bg-card p-5 text-card-foreground sm:p-6"
    >
      {item.status ? <p className="text-small font-bold text-muted-foreground">{item.status}</p> : null}
      <dl className="mt-3 grid gap-3">
        {cells.map((c) => (
          <div key={c.name} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
            <dt className="text-small text-muted-foreground">{c.label}</dt>
            <dd className="text-body font-bold wrap-break-word">{c.text}</dd>
          </div>
        ))}
      </dl>
      {cancel && item.canCancel ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          {asking ? (
            <>
              <p className="w-full text-body font-bold">{`${cancel.label}?`}</p>
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

/** One kind of records under its heading: loading, a load error, empty, the cards and «Показать ещё». */
function Block({ section, action, level }: { section: Section; action?: Link; level: 1 | 2 }) {
  const m = useMyRecords(section.entity, {
    ...(section.fields ? { fields: section.fields } : {}),
    ...(section.cancel ? { cancel: { field: section.cancel.field, value: section.cancel.value } } : {}),
  });
  const Tag = level === 1 ? "h2" : "h3";
  let body: ReactNode;
  if (m.error && m.items.length === 0)
    body = (
      <p role="alert" className="text-body font-bold">
        Не получилось загрузить ваши записи. Обновите страницу чуть позже.
      </p>
    );
  else if (m.isLoading && m.items.length === 0) body = <Loading />;
  else if (m.items.length === 0)
    body = (
      <div>
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
  else
    body = (
      <>
        {m.cancelError ? (
          <p role="alert" className="mb-4 text-body font-bold">
            {m.cancelError}
          </p>
        ) : null}
        <ul className="grid gap-4 md:grid-cols-2">
          {m.items.map((item) => (
            <Card key={item.id} m={m} item={item} {...(section.cancel ? { cancel: section.cancel } : {})} />
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
  return (
    <div id={section.id} className="scroll-mt-6">
      <Tag className="font-display text-h3 font-bold">{section.label}</Tag>
      <div className="mt-5">{body}</div>
    </div>
  );
}

export default function AccountList(props: AccountListProps) {
  const { title, text, sections, signIn, action, empty } = props;
  const level = props.level ?? 1;
  const Title = level === 1 ? "h1" : "h2";
  const uid = useId();
  const session = useClientSession();
  let body: ReactNode;
  if (session.isLoading) body = <Loading />;
  else if (!session.signedIn) body = <SignIn signIn={signIn} />;
  else if (sections.length === 0)
    body = (
      <p data-testid="wz-empty" className="text-body text-muted-foreground">
        {empty ?? "Здесь появятся ваши записи и заявки"}
      </p>
    );
  else
    body = (
      <div className="grid gap-14">
        {sections.map((s) => (
          <Block key={s.id} section={s} level={level} {...(action ? { action } : {})} />
        ))}
      </div>
    );
  return (
    <section
      data-wz-component="ClientCabinet"
      data-wz-id={props.wzId}
      aria-labelledby={`${uid}-title`}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="flex flex-col gap-4 border-b border-border pb-8 md:flex-row md:items-end md:justify-between">
          <div className="max-w-text min-w-0">
            <Title
              id={`${uid}-title`}
              className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
            >
              {title}
            </Title>
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
