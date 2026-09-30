// In-process circuit breaker per provider × model (models.yaml#call_policy.circuit_breaker, M0 state store).
const CONSECUTIVE = 5;
const WINDOW_CALLS = 20;
const WINDOW_MS = 60_000;
const WINDOW_ERRORS = 10;
const OPEN_MS = 60_000;
const MAX_OPEN_MS = 600_000;

interface State {
  consecutive: number;
  recent: { at: number; ok: boolean }[];
  openUntil: number;
  openMs: number;
  halfOpenTrial: boolean;
}

export class CircuitBreaker {
  private readonly states = new Map<string, State>();
  constructor(private readonly now: () => number = Date.now) {}

  private get(key: string): State {
    let s = this.states.get(key);
    if (!s) {
      s = { consecutive: 0, recent: [], openUntil: 0, openMs: OPEN_MS, halfOpenTrial: false };
      this.states.set(key, s);
    }
    return s;
  }

  /** true → the call may go out (closed, or the single half-open trial). */
  allow(key: string): boolean {
    const s = this.get(key);
    if (s.openUntil === 0) return true;
    if (this.now() < s.openUntil || s.halfOpenTrial) return false;
    s.halfOpenTrial = true;
    return true;
  }

  record(key: string, ok: boolean): void {
    const s = this.get(key);
    const at = this.now();
    if (s.halfOpenTrial) {
      s.halfOpenTrial = false;
      if (ok) this.reset(s);
      else {
        s.openMs = Math.min(s.openMs * 2, MAX_OPEN_MS);
        s.openUntil = at + s.openMs;
      }
      return;
    }
    s.consecutive = ok ? 0 : s.consecutive + 1;
    s.recent.push({ at, ok });
    s.recent = s.recent.filter((x) => at - x.at <= WINDOW_MS).slice(-WINDOW_CALLS);
    const errors = s.recent.filter((x) => !x.ok).length;
    if (s.consecutive >= CONSECUTIVE || errors >= WINDOW_ERRORS) {
      s.openUntil = at + s.openMs;
    }
  }

  private reset(s: State): void {
    s.consecutive = 0;
    s.recent = [];
    s.openUntil = 0;
    s.openMs = OPEN_MS;
  }
}
