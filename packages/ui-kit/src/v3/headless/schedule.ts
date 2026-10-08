// Free time of «Запись по слотам» for useBooking (V3-10): the schedule of the module (publicFront.actions[].booking of
// the backend compile, @wizard/modules scheduleOf) and the busy times of busySlots → working days and free slots with
// the first free seat. The same rules as the generated helpers of the v2 booking page (modules/src/booking/schedule.ts),
// here as functions over the schedule. Times are wall-clock minutes in the schedule's time zone.

/** Schedule constants of a system (ScheduleSpec of @wizard/modules). */
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
  breakStart: number | null;
  breakEnd: number | null;
  /** Seats at one time; 1 — one visitor per time. */
  capacity: number;
  /** A slot must start at least this many minutes from now. */
  leadMinutes: number;
}

/** An occupied time from busySlots (start, end and seat only — no names or contacts). */
export interface BusyTime {
  starts_at: string;
  ends_at: string | null;
  seat: number | null;
}

export interface FreeSlot {
  start: string;
  end: string;
  seat: number;
}

const MINUTE = 60_000;

function zoneOffset(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const n = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return (
    Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) -
    Math.floor(t / 1000) * 1000
  );
}

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y ?? 1970, (m ?? 1) - 1, d ?? 1];
}

/** Epoch ms of `minutes` after midnight of `day` (YYYY-MM-DD) in the time zone `tz`. */
export function zonedAt(tz: string, day: string, minutes: number): number {
  const [y, m, d] = ymd(day);
  const wall = Date.UTC(y, m, d, 0, minutes);
  return wall - zoneOffset(tz, wall - zoneOffset(tz, wall));
}

/** YYYY-MM-DD of an instant in the time zone `tz`. */
export function dayKey(tz: string, t: number): string {
  return new Date(t + zoneOffset(tz, t)).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

/** The next `count` working days from `from` (inclusive), looking at most 62 days ahead. */
export function workdays(s: ScheduleSpec, from: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 62 && out.length < count; i++) {
    const day = addDays(from, i);
    if (s.days.includes(weekdayOf(day))) out.push(day);
  }
  return out;
}

/** Slot starts of a working day (minutes) for a booking of `length` minutes, without the break. */
export function daySlots(s: ScheduleSpec, length: number): number[] {
  const out: number[] = [];
  for (let t = s.start; t + length <= s.end; t += s.step) {
    if (s.breakStart !== null && s.breakEnd !== null && t < s.breakEnd && t + length > s.breakStart) continue;
    out.push(t);
  }
  return out;
}

/** Free slots of `day` for a booking of `minutes` (or one step): the first seat no overlapping booking holds. */
export function freeSlots(
  s: ScheduleSpec,
  day: string,
  minutes: number | null,
  busy: readonly BusyTime[],
  now: number,
): FreeSlot[] {
  if (!s.days.includes(weekdayOf(day))) return [];
  const length = minutes && minutes > 0 ? minutes : s.step;
  const out: FreeSlot[] = [];
  for (const t of daySlots(s, length)) {
    const a = zonedAt(s.tz, day, t);
    const b = zonedAt(s.tz, day, t + length);
    if (a <= now + s.leadMinutes * MINUTE) continue;
    const held = new Set<number>();
    for (const x of busy) {
      const start = Date.parse(x.starts_at);
      const end = x.ends_at ? Date.parse(x.ends_at) : start + s.step * MINUTE;
      if (x.seat !== null && start < b && end > a) held.add(x.seat);
    }
    let seat = 0;
    for (let k = 1; k <= s.capacity && seat === 0; k++) if (!held.has(k)) seat = k;
    if (seat > 0) out.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), seat });
  }
  return out;
}
