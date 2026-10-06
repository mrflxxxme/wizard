// Schedule of «Запись по слотам»: the module's parameters → constants and the TypeScript helpers compiled into the
// booking page and the module's functions (generated code may import only @wizard/sdk and @wizard/ui-kit, so the
// helpers travel as source). Times are wall-clock minutes in the system's time zone (Europe/Moscow by default).
import { js } from "../screens/jsx.js";

/** Schedule constants of a system (ScheduleSpec in the generated code). */
export interface ScheduleSpec {
  /** IANA time zone of the working hours. */
  tz: string;
  /** Working weekdays, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Start and end of the working day, minutes from midnight. */
  start: number;
  end: number;
  /** Slot step, minutes; also the length of a booking whose service has no duration. */
  step: number;
  /** Break, minutes from midnight (both or none). */
  breakStart: number | null;
  breakEnd: number | null;
  /** Seats at one time (a group); 1 — one visitor per time. */
  capacity: number;
  /** A slot must start at least this many minutes from now. */
  leadMinutes: number;
}

export const DEFAULT_TIMEZONE = "Europe/Moscow";
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const minutesOf = (t: unknown): number | null => {
  if (typeof t !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Schedule constants from the module parameters (with defaults) and the spec's time zone. */
export function scheduleOf(params: Readonly<Record<string, unknown>>, tz = DEFAULT_TIMEZONE): ScheduleSpec {
  const days = ((params.workdays as string[] | undefined) ?? ["mon", "tue", "wed", "thu", "fri"])
    .map((d) => WEEKDAYS.indexOf(d))
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  const start = minutesOf(params.day_start) ?? 9 * 60;
  const end = minutesOf(params.day_end) ?? 18 * 60;
  const bs = minutesOf(params.break_start);
  const be = minutesOf(params.break_end);
  const brk = bs !== null && be !== null && bs < be;
  return {
    tz,
    days,
    start,
    end,
    step: Number(params.slot_minutes ?? 60),
    breakStart: brk ? bs : null,
    breakEnd: brk ? be : null,
    capacity: Number(params.capacity ?? 1),
    leadMinutes: 0,
  };
}

/** Russian notes for the plan screen when the parameters contradict each other. */
export function scheduleWarnings(params: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const start = minutesOf(params.day_start) ?? 9 * 60;
  const end = minutesOf(params.day_end) ?? 18 * 60;
  const step = Number(params.slot_minutes ?? 60);
  if (end - start < step)
    out.push(
      "Рабочий день короче шага расписания: свободного времени для записи не будет — проверьте часы работы",
    );
  const bs = minutesOf(params.break_start);
  const be = minutesOf(params.break_end);
  if ((bs === null) !== (be === null))
    out.push("Перерыв задан не полностью (нужны начало и конец) — сейчас он не учитывается");
  else if (bs !== null && be !== null && (bs >= be || bs < start || be > end))
    out.push(
      "Перерыв должен быть внутри рабочего дня и заканчиваться позже, чем начинается — сейчас он не учитывается",
    );
  return out;
}

/**
 * TypeScript source of the schedule helpers for generated code: `SCHEDULE` and pure functions over it — `zonedAt`
 * (day + minutes → epoch ms), `dayKey`, `addDays`, `weekdayOf`, `workdays`, `daySlots` (slot starts of a day without
 * the break), `freeSlots` (free slots with the first free seat), `slotsPerDay`.
 */
export function scheduleSource(s: ScheduleSpec): string {
  return `// ---- schedule of the module «Запись по слотам» (generated; times are minutes in SCHEDULE.tz) ----
type ScheduleSpec = {
  tz: string;
  days: number[];
  start: number;
  end: number;
  step: number;
  breakStart: number | null;
  breakEnd: number | null;
  capacity: number;
  leadMinutes: number;
};
type BusyTime = { starts_at: string; ends_at: string | null; seat: number | null };
type FreeSlot = { start: string; end: string; seat: number };

const SCHEDULE: ScheduleSpec = ${js(s)};
const MINUTE = 60_000;

function zoneOffset(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE.tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const n = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(t / 1000) * 1000;
}

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y ?? 1970, (m ?? 1) - 1, d ?? 1];
}

/** Epoch ms of \`minutes\` after midnight of \`day\` (YYYY-MM-DD) in SCHEDULE.tz. */
function zonedAt(day: string, minutes: number): number {
  const [y, m, d] = ymd(day);
  const wall = Date.UTC(y, m, d, 0, minutes);
  return wall - zoneOffset(wall - zoneOffset(wall));
}

/** YYYY-MM-DD of an instant in SCHEDULE.tz. */
function dayKey(t: number): string {
  return new Date(t + zoneOffset(t)).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

/** The next \`count\` working days from \`from\` (inclusive), looking at most 62 days ahead. */
function workdays(from: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 62 && out.length < count; i++) {
    const day = addDays(from, i);
    if (SCHEDULE.days.includes(weekdayOf(day))) out.push(day);
  }
  return out;
}

/** Slot starts of a working day (minutes) for a booking of \`length\` minutes, without the break. */
function daySlots(length: number): number[] {
  const out: number[] = [];
  for (let t = SCHEDULE.start; t + length <= SCHEDULE.end; t += SCHEDULE.step) {
    const bs = SCHEDULE.breakStart;
    const be = SCHEDULE.breakEnd;
    if (bs !== null && be !== null && t < be && t + length > bs) continue;
    out.push(t);
  }
  return out;
}

/** Slots of one length per working day (the capacity of a day for one resource and seat). */
function slotsPerDay(): number {
  return daySlots(SCHEDULE.step).length;
}

/** Free slots of \`day\` for a booking of \`minutes\` (or one step): the first seat no overlapping booking holds. */
function freeSlots(day: string, minutes: number | null, busy: readonly BusyTime[], now: number): FreeSlot[] {
  if (!SCHEDULE.days.includes(weekdayOf(day))) return [];
  const length = minutes && minutes > 0 ? minutes : SCHEDULE.step;
  const out: FreeSlot[] = [];
  for (const t of daySlots(length)) {
    const a = zonedAt(day, t);
    const b = zonedAt(day, t + length);
    if (a <= now + SCHEDULE.leadMinutes * MINUTE) continue;
    const held = new Set<number>();
    for (const x of busy) {
      const s = Date.parse(x.starts_at);
      const e = x.ends_at ? Date.parse(x.ends_at) : s + SCHEDULE.step * MINUTE;
      if (x.seat !== null && s < b && e > a) held.add(x.seat);
    }
    let seat = 0;
    for (let k = 1; k <= SCHEDULE.capacity && seat === 0; k++) if (!held.has(k)) seat = k;
    if (seat > 0) out.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), seat });
  }
  return out;
}
// ---- end of schedule ----
`;
}
