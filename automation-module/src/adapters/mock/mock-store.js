import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_STATE_DIR } from '../../paths.js';

/**
 * Minimal transactional JSON document store, persisted inside automation-module/.local/.
 *
 * - Single-process async mutex serializes read-modify-write cycles (concurrent processing safe).
 * - Writes are atomic (write temp file + rename) so a crash cannot leave a half-written file.
 * - Concurrency across multiple OS processes is NOT provided in V1; production uses Postgres
 *   unique constraints + SELECT ... FOR UPDATE SKIP LOCKED (see db/proposals/). Local claiming
 *   inside one process mirrors that contract for tests.
 */

export class Mutex {
  constructor() {
    this._chain = Promise.resolve();
  }

  /** Run fn exclusively. */
  async run(fn) {
    const prev = this._chain;
    let release;
    this._chain = new Promise((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function emptyState() {
  return {
    version: 1,
    events: {},       // event_id -> stored event record
    notifications: {},// notification_id -> notification record
    notificationKeys: {}, // idempotency_key -> notification_id
    deliveries: {},   // delivery_id -> delivery record
    deliveryKeys: {}, // idempotency_key -> delivery_id
    audit: [],        // append-only audit entries
    sequences: { audit: 0, notification: 0, delivery: 0 },
    metrics: { processingDurationMsTotal: 0, processingDurationMsMax: 0, processingSamples: 0 },
  };
}

export class MockStore {
  /**
   * @param {{ filePath?: string, clock?: {now(): Date} }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? path.join(LOCAL_STATE_DIR, 'store.json');
    this.clock = options.clock ?? { now: () => new Date() };
    this._mutex = new Mutex();
    this._state = null;
  }

  async _load() {
    if (this._state) return this._state;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this._state = { ...emptyState(), ...parsed };
    } catch (err) {
      if (err && err.code === 'ENOENT') this._state = emptyState();
      else throw err;
    }
    return this._state;
  }

  async _persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this._state, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  /** Read-only snapshot. */
  async read() {
    const state = await this._load();
    return state;
  }

  /** Atomically mutate state inside the store mutex. */
  async update(fn) {
    return this._mutex.run(async () => {
      const state = await this._load();
      const result = await fn(state);
      await this._persist();
      return result;
    });
  }

  /** Run fn under the mutex without persisting (for compound checks inside update). */
  async withLock(fn) {
    return this._mutex.run(async () => fn(await this._load()));
  }

  /** Test helper: wipe state. */
  async reset() {
    this._state = emptyState();
    await this._persist();
  }

  /** Test helper: remove persisted file. */
  async destroy() {
    this._state = null;
    await rm(this.filePath, { force: true });
  }

  /** Probe writability for health checks. */
  async probeWritable() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe.${process.pid}.tmp`);
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return true;
  }
}
