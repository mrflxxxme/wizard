import {
  BRIEF_ACTORS,
  BRIEF_FIELD_LABELS,
  type BriefActor,
  type BriefError,
  type SystemBrief,
  validateBrief,
} from "@wizard/appspec";
import { type ReactNode, useId, useRef, useState } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import { ActionButton, Chip } from "../controls.js";
import s from "./BriefEditor.module.css";
import { ACTOR_RU } from "./text.js";

/** Sections the owner edits in the panel; the rest the interview fills (D77 (9)). */
export const BRIEF_EDITABLE_SECTIONS = ["goals", "scenarios", "roles", "outOfScope", "assumptions"] as const;
export type BriefEditableSection = (typeof BRIEF_EDITABLE_SECTIONS)[number];

export interface BriefEditorProps extends PBase {
  brief: SystemBrief;
  /** The version being edited: it goes back with the edit (412 VERSION_CONFLICT when someone changed it meanwhile). */
  baseVersion: number;
  /** Section to open (default — goals). */
  section?: BriefEditableSection;
  /** The edited brief, valid by validateBrief, and the version it was made on. */
  onSave(brief: SystemBrief, baseVersion: number): void;
  onCancel?(): void;
  busy?: boolean;
  /** Error of the last save (from the server), shown above the buttons. */
  error?: string | null;
}

interface GoalRow {
  uid: number;
  id: string;
  text: string;
  success: string;
}
interface ScenarioRow {
  uid: number;
  id: string;
  actor: BriefActor;
  when: string;
  steps: string;
  goalId: string;
  must: boolean;
  moduleHint?: string;
}
interface RoleRow {
  uid: number;
  id: string;
  name: string;
  can: string;
}
interface OutRow {
  uid: number;
  text: string;
  substitute: string;
}
interface AssumptionRow {
  uid: number;
  text: string;
  source: SystemBrief["assumptions"][number]["source"];
}
interface Draft {
  goals: GoalRow[];
  scenarios: ScenarioRow[];
  roles: RoleRow[];
  outOfScope: OutRow[];
  assumptions: AssumptionRow[];
}

const ADD: Record<BriefEditableSection, string> = {
  goals: "Добавить цель",
  scenarios: "Добавить сценарий",
  roles: "Добавить роль",
  outOfScope: "Добавить пункт",
  assumptions: "Добавить допущение",
};
const ITEM: Record<BriefEditableSection, string> = {
  goals: "Цель",
  scenarios: "Сценарий",
  roles: "Роль",
  outOfScope: "Не входит",
  assumptions: "Допущение",
};
const HINT: Record<BriefEditableSection, string> = {
  goals: "Чего система должна добиться и по какому признаку поймём, что получилось.",
  scenarios: "Что происходит и что делает система в ответ — это и есть проверка готовой сборки.",
  roles: "Кто работает в системе и что ему можно.",
  outOfScope: "Что сейчас не делаем — и чем это заменить.",
  assumptions: "Что решили по умолчанию. Уберите или поправьте, если это не так.",
};

const lines = (t: string) =>
  t
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function draftOf(b: SystemBrief, next: () => number): Draft {
  return {
    goals: b.goals.map((g) => ({ uid: next(), id: g.id, text: g.text, success: g.success })),
    scenarios: b.scenarios.map((x) => ({
      uid: next(),
      id: x.id,
      actor: x.actor,
      when: x.when,
      steps: x.then.join("\n"),
      goalId: x.goalId ?? "",
      must: x.priority === "must",
      ...(x.moduleHint ? { moduleHint: x.moduleHint } : {}),
    })),
    roles: b.roles.map((r) => ({ uid: next(), id: r.id, name: r.name, can: r.can.join("\n") })),
    outOfScope: b.outOfScope.map((o) => ({ uid: next(), text: o.text, substitute: o.substitute ?? "" })),
    assumptions: b.assumptions.map((a) => ({ uid: next(), text: a.text, source: a.source })),
  };
}

/** A new id «<prefix>_<n>» not used in the list. */
function freshId(prefix: string, used: readonly string[]): string {
  for (let n = used.length + 1; ; n++) if (!used.includes(`${prefix}_${n}`)) return `${prefix}_${n}`;
}

/** The brief with the edited sections; empty rows are dropped, links to removed goals are cleared. */
function applyDraft(b: SystemBrief, d: Draft): unknown {
  const goals = d.goals
    .filter((g) => g.text.trim() || g.success.trim())
    .map((g) => ({ id: g.id, text: g.text.trim(), success: g.success.trim() }));
  const goalIds = new Set(goals.map((g) => g.id));
  const scenarios = d.scenarios
    .filter((x) => x.when.trim() || x.steps.trim())
    .map((x) => {
      const goalId = x.goalId && goalIds.has(x.goalId) ? x.goalId : undefined;
      return {
        id: x.id,
        actor: x.actor,
        when: x.when.trim(),
        // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
        then: lines(x.steps),
        ...(goalId ? { goalId } : {}),
        ...(x.moduleHint ? { moduleHint: x.moduleHint } : {}),
        priority: x.must ? "must" : "should",
      };
    });
  return {
    ...b,
    goals,
    scenarios,
    roles: d.roles
      .filter((r) => r.name.trim() || r.can.trim())
      .map((r) => ({ id: r.id, name: r.name.trim(), can: lines(r.can) })),
    outOfScope: d.outOfScope
      .filter((o) => o.text.trim())
      .map((o) => ({
        text: o.text.trim(),
        ...(o.substitute.trim() ? { substitute: o.substitute.trim() } : {}),
      })),
    assumptions: d.assumptions
      .filter((a) => a.text.trim())
      .map((a) => ({ text: a.text.trim(), source: a.source })),
  };
}

function Field({
  label,
  value,
  onChange,
  multiline,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
}): ReactNode {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.label}>
        {label}
        {hint && <span className={s.hint}> · {hint}</span>}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={cx(s.input, s.area)}
          value={value}
          rows={Math.min(6, Math.max(2, value.split("\n").length))}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className={s.input}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

/**
 * Edit of the brief in the «Бриф» panel (D77 (9)): goals, scenarios, roles, «не входит» and assumptions as short forms,
 * one section at a time. Saving checks the brief by validateBrief and gives the whole brief with the version it was
 * made on to onSave — the server writes it as a new version.
 */
export function BriefEditor({
  brief,
  baseVersion,
  section: initial = "goals",
  onSave,
  onCancel,
  busy = false,
  error = null,
  className,
  testId,
}: BriefEditorProps): ReactNode {
  const uid = useRef(0);
  const next = () => ++uid.current;
  const [draft, setDraft] = useState<Draft>(() => draftOf(brief, next));
  const [section, setSection] = useState<BriefEditableSection>(initial);
  const [errors, setErrors] = useState<BriefError[]>([]);
  const hid = useId();

  function update<K extends BriefEditableSection>(key: K, rows: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: rows }));
    setErrors([]);
  }
  function patch<K extends BriefEditableSection>(key: K, row: number, p: Partial<Draft[K][number]>) {
    update(key, draft[key].map((r) => (r.uid === row ? { ...r, ...p } : r)) as Draft[K]);
  }
  function remove(key: BriefEditableSection, row: number) {
    update(key, draft[key].filter((r) => r.uid !== row) as never);
  }
  function add(key: BriefEditableSection) {
    const u = next();
    const rows: Record<BriefEditableSection, () => unknown> = {
      goals: () => ({
        uid: u,
        id: freshId(
          "g",
          draft.goals.map((g) => g.id),
        ),
        text: "",
        success: "",
      }),
      scenarios: () => ({
        uid: u,
        id: freshId(
          "s",
          draft.scenarios.map((x) => x.id),
        ),
        actor: "visitor",
        when: "",
        steps: "",
        goalId: "",
        must: true,
      }),
      roles: () => ({
        uid: u,
        id: freshId(
          "role",
          draft.roles.map((r) => r.id),
        ),
        name: "",
        can: "",
      }),
      outOfScope: () => ({ uid: u, text: "", substitute: "" }),
      assumptions: () => ({ uid: u, text: "", source: "default" }),
    };
    update(key, [...draft[key], rows[key]()] as never);
  }

  function save() {
    const valid = validateBrief(applyDraft(brief, draft));
    if (!valid.ok) {
      setErrors(valid.errors);
      return;
    }
    onSave(valid.brief, baseVersion);
  }

  const goals = draft.goals.filter((g) => g.text.trim());
  const shown = errors.slice(0, 4);
  return (
    <form
      {...pRoot("BriefEditor", testId, "p-brief-editor")}
      aria-labelledby={hid}
      className={cx(s.editor, className)}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) save();
      }}
    >
      <h3 id={hid} className={s.srOnly}>
        Правка брифа
      </h3>
      <fieldset className={s.sections}>
        <legend className={s.srOnly}>Что править</legend>
        {BRIEF_EDITABLE_SECTIONS.map((k) => (
          <Chip
            key={k}
            tone="outline"
            pressed={section === k}
            testId={`p-brief-edit-section-${k}`}
            onClick={() => setSection(k)}
          >
            {BRIEF_FIELD_LABELS[k]}
          </Chip>
        ))}
      </fieldset>
      <p className={s.lead}>{HINT[section]}</p>
      <ol className={s.items} data-testid={`p-brief-edit-${section}`}>
        {section === "goals" &&
          draft.goals.map((g, i) => (
            <li key={g.uid} className={s.item}>
              <p className={s.itemHead}>
                {ITEM.goals} {i + 1}
              </p>
              <Field
                label="Чего хотим добиться"
                value={g.text}
                placeholder="Получать заявки с сайта"
                onChange={(v) => patch("goals", g.uid, { text: v })}
              />
              <Field
                label="Как поймём, что получилось"
                value={g.success}
                placeholder="30 заявок в месяц"
                onChange={(v) => patch("goals", g.uid, { success: v })}
              />
              <Remove what={`${ITEM.goals.toLowerCase()} ${i + 1}`} onClick={() => remove("goals", g.uid)} />
            </li>
          ))}
        {section === "scenarios" &&
          draft.scenarios.map((x, i) => (
            <li key={x.uid} className={s.item}>
              <p className={s.itemHead}>
                {ITEM.scenarios} {i + 1}
              </p>
              <Select
                label="Кто действует"
                value={x.actor}
                options={BRIEF_ACTORS.map((a) => [a, ACTOR_RU[a]] as const)}
                onChange={(v) => patch("scenarios", x.uid, { actor: v as BriefActor })}
              />
              <Field
                label="Когда"
                value={x.when}
                placeholder="клиент оставляет заявку"
                onChange={(v) => patch("scenarios", x.uid, { when: v })}
              />
              <Field
                label="Что делает система"
                hint="по шагу в строке"
                multiline
                value={x.steps}
                placeholder={"сохраняет заявку\nуведомляет менеджера"}
                onChange={(v) => patch("scenarios", x.uid, { steps: v })}
              />
              <div className={s.row}>
                <Select
                  label="Для какой цели"
                  value={x.goalId}
                  options={[["", "без цели"], ...goals.map((g) => [g.id, g.text] as const)]}
                  onChange={(v) => patch("scenarios", x.uid, { goalId: v })}
                />
                <Check
                  label="Обязательно к сборке"
                  checked={x.must}
                  onChange={(v) => patch("scenarios", x.uid, { must: v })}
                />
              </div>
              <Remove
                what={`${ITEM.scenarios.toLowerCase()} ${i + 1}`}
                onClick={() => remove("scenarios", x.uid)}
              />
            </li>
          ))}
        {section === "roles" &&
          draft.roles.map((r, i) => (
            <li key={r.uid} className={s.item}>
              <p className={s.itemHead}>
                {ITEM.roles} {i + 1}
              </p>
              <Field
                label="Название"
                value={r.name}
                placeholder="Администратор"
                onChange={(v) => patch("roles", r.uid, { name: v })}
              />
              <Field
                label="Что может"
                hint="по пункту в строке"
                multiline
                value={r.can}
                placeholder={"видит все заявки\nменяет статусы"}
                onChange={(v) => patch("roles", r.uid, { can: v })}
              />
              <Remove what={`${ITEM.roles.toLowerCase()} ${i + 1}`} onClick={() => remove("roles", r.uid)} />
            </li>
          ))}
        {section === "outOfScope" &&
          draft.outOfScope.map((o, i) => (
            <li key={o.uid} className={s.item}>
              <p className={s.itemHead}>
                {ITEM.outOfScope} · {i + 1}
              </p>
              <Field
                label="Что не делаем сейчас"
                value={o.text}
                placeholder="Мобильное приложение"
                onChange={(v) => patch("outOfScope", o.uid, { text: v })}
              />
              <Field
                label="Чем заменим"
                hint="можно оставить пустым"
                value={o.substitute}
                placeholder="Сайт, удобный с телефона"
                onChange={(v) => patch("outOfScope", o.uid, { substitute: v })}
              />
              <Remove what={`пункт ${i + 1}`} onClick={() => remove("outOfScope", o.uid)} />
            </li>
          ))}
        {section === "assumptions" &&
          draft.assumptions.map((a, i) => (
            <li key={a.uid} className={s.item}>
              <Field
                label={`${ITEM.assumptions} ${i + 1}`}
                multiline
                value={a.text}
                onChange={(v) => patch("assumptions", a.uid, { text: v })}
              />
              <Remove
                what={`${ITEM.assumptions.toLowerCase()} ${i + 1}`}
                onClick={() => remove("assumptions", a.uid)}
              />
            </li>
          ))}
      </ol>
      <div className={s.addRow}>
        <ActionButton
          size="sm"
          variant="ghost"
          testId={`p-brief-add-${section}`}
          onClick={() => add(section)}
        >
          + {ADD[section]}
        </ActionButton>
      </div>
      {(shown.length > 0 || error) && (
        <div role="alert" className={s.errors} data-testid="p-brief-editor-errors">
          {error && <p>{error}</p>}
          {shown.length > 0 && (
            <>
              <p>Не получается сохранить — поправьте:</p>
              <ul>
                {shown.map((e) => (
                  <li key={`${e.path}${e.code}`}>{e.message_ru}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className={s.foot}>
        {onCancel && (
          <ActionButton variant="ghost" testId="p-brief-cancel" disabled={busy} onClick={onCancel}>
            Отмена
          </ActionButton>
        )}
        <ActionButton variant="primary" type="submit" testId="p-brief-save" busy={busy} disabled={busy}>
          {busy ? "Сохраняю…" : "Сохранить новую версию"}
        </ActionButton>
      </div>
    </form>
  );
}

function Remove({ what, onClick }: { what: string; onClick(): void }): ReactNode {
  return (
    <div className={s.removeRow}>
      <button type="button" className={s.remove} aria-label={`Убрать ${what}`} onClick={onClick}>
        Убрать
      </button>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange(v: string): void;
}): ReactNode {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.label}>
        {label}
      </label>
      <select
        id={id}
        className={cx(s.input, s.select)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
}): ReactNode {
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
