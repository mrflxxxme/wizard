// StatusBoard (ui-kit.yaml#components.StatusBoard): kanban by an enum field; pointer drag-and-drop without
// libraries, keyboard alternative «Перенести в…», optimistic move with rollback, tabs on sm. After its own move the
// board re-reads its columns (B2-28): without live updates (no event stream) the card would jump back.
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { cx, useCan, useDataSource, useRoleSpec, useWzRoot } from "../data/context.js";
import { fieldOf } from "../data/roleSpec.js";
import type { Rec, WzError } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { useCabinetLook } from "./look.js";
import { DataState } from "./States.js";
import styles from "./StatusBoard.module.css";
import type { StatusBoardProps } from "./types.js";

/** A move of a card: optimistic while the write runs; `done` — written, kept until the column re-read shows it. */
type Move = { to: string; row: Rec; done?: boolean };
type Drag = { id: string; from: string; x: number; y: number; dx: number; dy: number; active: boolean };

export function StatusBoard<T = Rec>(props: StatusBoardProps<T>): ReactNode {
  const root = useWzRoot("StatusBoard", "wz-statusboard", props);
  const look = useCabinetLook();
  const spec = useRoleSpec();
  const can = useCan();
  const update = useDataSource().useUpdate(props.entity);
  const field = fieldOf(spec, props.entity, props.statusField);
  const values = props.columns ?? (field?.enum ?? []).map((o) => o.value);
  const label = (v: string) => field?.enum?.find((o) => o.value === v)?.label ?? v;
  const canMove = can("update", props.entity, props.statusField);
  const [moves, setMoves] = useState<Record<string, Move>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [tab, setTab] = useState(values[0] ?? "");
  const [alert, setAlert] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Bumped after each own move: every column re-reads its list. */
  const [reload, setReload] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);

  const move = async (row: Rec, from: string, to: string) => {
    if (from === to || !canMove) return;
    setAlert(null);
    setStatus(null);
    setMoves((m) => ({ ...m, [row.id]: { to, row: { ...row, [props.statusField]: to } } }));
    try {
      await update.mutate(row.id, { [props.statusField]: to });
      setStatus(ru.statusBoard.moved(label(to)));
      // The card stays in its new column until the re-read lists show it there.
      setMoves((m) =>
        m[row.id]?.to === to ? { ...m, [row.id]: { ...(m[row.id] as Move), done: true } } : m,
      );
      setReload((n) => n + 1);
    } catch (e) {
      setAlert((e as WzError).message);
      setMoves(({ [row.id]: _, ...rest }) => rest);
    }
  };
  const settled = (id: string) =>
    setMoves((m) => {
      if (!m[id]?.done) return m;
      const { [id]: _, ...rest } = m;
      return rest;
    });

  const dragRef = useRef<Drag | null>(null);
  const onPointerDown = (e: ReactPointerEvent, row: Rec, from: string) => {
    if (!canMove || e.button !== 0 || (e.target as HTMLElement).closest("[data-nodrag]")) return;
    dragRef.current = { id: row.id, from, x: e.clientX, y: e.clientY, dx: 0, dy: 0, active: false };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      dragRef.current = { ...d, dx, dy, active: d.active || Math.hypot(dx, dy) > 6 };
      setDrag(dragRef.current);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.active) return;
      const target = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .map((el) => el.closest<HTMLElement>("[data-column]"))
        .find((el) => el && boardRef.current?.contains(el));
      const to = target?.dataset.column;
      if (to) void move(row, from, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section {...root} {...look} className={cx(styles.board, props.className)}>
      <div className={styles.tabs} role="tablist" aria-label={field?.label}>
        {values.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            className={styles.tab}
            onClick={() => setTab(v)}
          >
            {label(v)} <span className={styles.count}>{totals[v] ?? 0}</span>
          </button>
        ))}
      </div>
      {alert && (
        <p role="alert" className={styles.alert}>
          {alert}
        </p>
      )}
      {status && (
        <p role="status" className={styles.status}>
          {status}
        </p>
      )}
      <div ref={boardRef} className={styles.columns}>
        {values.map((v) => (
          <Column
            key={v}
            {...props}
            value={v}
            title={label(v)}
            active={tab === v}
            values={values}
            label={label}
            moves={moves}
            canMove={canMove}
            drag={drag}
            onTotal={(n) => setTotals((t) => (t[v] === n ? t : { ...t, [v]: n }))}
            onMove={move}
            reload={reload}
            onSettled={settled}
            onPointerDown={onPointerDown}
          />
        ))}
      </div>
    </section>
  );
}

function Column<T>(
  props: StatusBoardProps<T> & {
    value: string;
    title: string;
    active: boolean;
    values: string[];
    label(v: string): string;
    moves: Record<string, Move>;
    canMove: boolean;
    drag: Drag | null;
    onTotal(n: number): void;
    onMove(row: Rec, from: string, to: string): void;
    reload: number;
    onSettled(id: string): void;
    onPointerDown(e: ReactPointerEvent, row: Rec, from: string): void;
  },
): ReactNode {
  const { value, moves, statusField, onTotal, reload, onSettled } = props;
  const limit = props.limitPerColumn ?? 50;
  const list = useDataSource().useList<Rec>(props.entity, {
    ...props.query,
    filter: { ...(props.query?.filter ?? {}), [statusField]: value },
    pageSize: Math.min(limit, 100),
  });
  const server = list.data?.items ?? [];
  const leaving = server.filter((r) => moves[r.id] && moves[r.id]?.to !== value).length;
  const arriving = Object.values(moves)
    .filter((m) => m.to === value && !server.some((r) => r.id === m.row.id))
    .map((m) => m.row);
  const rows = [...arriving, ...server.filter((r) => !moves[r.id] || moves[r.id]?.to === value)];
  const total = (list.data?.total ?? 0) - leaving + arriving.length;
  useEffect(() => onTotal(total), [onTotal, total]);
  const refetch = useRef(list.refetch);
  refetch.current = list.refetch;
  useEffect(() => {
    if (reload > 0) refetch.current();
  }, [reload]);
  // A written move is over once this column's list has the card with its new value.
  useEffect(() => {
    for (const r of server) if (moves[r.id]?.done && moves[r.id]?.to === value) onSettled(r.id);
  }, [server, moves, value, onSettled]);
  const [menu, setMenu] = useState<string | null>(null);
  const headingId = `wz-sb-${statusField}-${value}`;

  return (
    <section
      className={cx(styles.column, props.active && styles.activeColumn)}
      data-column={value}
      data-testid={`wz-statusboard-column-${value}`}
      aria-labelledby={headingId}
      aria-busy={list.isLoading || undefined}
    >
      <h3 id={headingId} className={styles.columnTitle}>
        {props.title} <span className={styles.count}>{total}</span>
      </h3>
      {!list.data ? (
        <DataState result={list} lines={2} />
      ) : (
        <ul className={styles.cards}>
          {rows.map((r) => {
            const c = props.card(r as T);
            const dragging = props.drag?.id === r.id && props.drag.active;
            return (
              <li
                key={r.id}
                className={cx(styles.card, props.canMove && styles.draggable, dragging && styles.dragging)}
                data-testid="wz-statusboard-card"
                data-id={r.id}
                style={
                  dragging
                    ? ({ "--w-drag-x": `${props.drag?.dx}px`, "--w-drag-y": `${props.drag?.dy}px` } as never)
                    : undefined
                }
                onPointerDown={(e) => props.onPointerDown(e, r, value)}
              >
                {props.onCardClick ? (
                  <button
                    type="button"
                    className={styles.cardMain}
                    onClick={() => props.onCardClick?.(r as T)}
                  >
                    <CardText {...c} />
                  </button>
                ) : (
                  <div className={styles.cardMain}>
                    <CardText {...c} />
                  </div>
                )}
                {props.canMove && (
                  <div className={styles.moveWrap} data-nodrag="">
                    <button
                      type="button"
                      className={styles.moveToggle}
                      aria-expanded={menu === r.id}
                      onClick={() => setMenu((m) => (m === r.id ? null : r.id))}
                    >
                      {ru.statusBoard.moveTo}
                    </button>
                    {menu === r.id && (
                      <ul className={styles.menu}>
                        {props.values
                          .filter((v) => v !== value)
                          .map((v) => (
                            <li key={v}>
                              <button
                                type="button"
                                className={styles.menuItem}
                                data-testid={`wz-statusboard-move-${v}`}
                                onClick={() => {
                                  setMenu(null);
                                  props.onMove(r, value, v);
                                }}
                              >
                                {ru.statusBoard.moveToValue(props.label(v))}
                              </button>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {total > rows.length && <p className={styles.more}>{ru.statusBoard.more(total - rows.length)}</p>}
    </section>
  );
}

function CardText({ title, subtitle, meta }: { title: string; subtitle?: string; meta?: string }): ReactNode {
  return (
    <>
      <span className={styles.cardTitle}>{title}</span>
      {subtitle && <span className={styles.cardSub}>{subtitle}</span>}
      {meta && <span className={styles.cardMeta}>{meta}</span>}
    </>
  );
}
