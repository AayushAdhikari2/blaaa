/**
 * Injectable clock. All time in the engine flows through a Clock so tests are deterministic.
 * @typedef {{ now(): Date }} Clock
 */

/** Real wall-clock. */
export function systemClock() {
  return { now: () => new Date() };
}

/** Deterministic test clock. */
export class ManualClock {
  /** @param {string|number|Date} start */
  constructor(start = '2024-01-01T00:00:00.000Z') {
    this._ms = new Date(start).getTime();
  }

  now() {
    return new Date(this._ms);
  }

  /** Advance by milliseconds. */
  advance(ms) {
    this._ms += ms;
    return this;
  }

  set(when) {
    this._ms = new Date(when).getTime();
    return this;
  }

  iso() {
    return this.now().toISOString();
  }
}

/** ISO-8601 string for a clock. */
export function isoNow(clock) {
  return clock.now().toISOString();
}
