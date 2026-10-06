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

/** models.yaml#fallback_rules (D76): a provider with an empty balance is skipped by every route for 30 min. */
export const BALANCE_BLOCK_MS = 30 * 60_000;

export class CircuitBreaker {
  private readonly states = new Map<string, State>();
  /** Provider-wide blocks (balance exhausted): provider id → instant the block ends. */
  private readonly providers = new Map<string, number>();
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

  /** Records an attempt; true → this failure has just opened a closed circuit (not a failed half-open trial). */
  record(key: string, ok: boolean): boolean {
    const s = this.get(key);
    const at = this.now();
    if (s.halfOpenTrial) {
      s.halfOpenTrial = false;
      if (ok) this.reset(s);
      else {
        s.openMs = Math.min(s.openMs * 2, MAX_OPEN_MS);
        s.openUntil = at + s.openMs;
      }
      return false;
    }
    s.consecutive = ok ? 0 : s.consecutive + 1;
    s.recent.push({ at, ok });
    s.recent = s.recent.filter((x) => at - x.at <= WINDOW_MS).slice(-WINDOW_CALLS);
    const errors = s.recent.filter((x) => !x.ok).length;
    if (s.consecutive >= CONSECUTIVE || errors >= WINDOW_ERRORS) {
      const opened = s.openUntil === 0;
      s.openUntil = at + s.openMs;
      return opened;
    }
    return false;
  }

  /** Blocks every model of `provider` for `ms`; true → the provider was not blocked before (one alert per episode). */
  blockProvider(provider: string, ms: number = BALANCE_BLOCK_MS): boolean {
    const was = this.providerBlocked(provider);
    this.providers.set(provider, Math.max(this.providers.get(provider) ?? 0, this.now() + ms));
    return !was;
  }

  /** true → `provider` is blocked (balance exhausted) and no call may go to it. */
  providerBlocked(provider: string): boolean {
    const until = this.providers.get(provider);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.providers.delete(provider);
    return false;
  }

  /** Lifts a provider block at once (the balance was topped up). */
  unblockProvider(provider: string): void {
    this.providers.delete(provider);
  }

  private reset(s: State): void {
    s.consecutive = 0;
    s.recent = [];
    s.openUntil = 0;
    s.openMs = OPEN_MS;
  }
}
