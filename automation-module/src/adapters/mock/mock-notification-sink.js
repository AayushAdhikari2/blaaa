import { TransientError, PermanentError } from '../../core/errors.js';

/**
 * Local mock notification delivery target (spec section 11: "V1 notification delivery is
 * mock/local only. Do not send email, SMS or WhatsApp."). Delivered notifications land in
 * an in-memory inbox. NO network. Deterministic failure injection for tests/dashboard.
 *
 * NotificationSink contract: `async deliver(notification) => void` (throws on failure).
 */

export class MockNotificationSink {
  constructor() {
    this.inbox = [];            // delivered notifications (recipient inbox), safe copies
    this.calls = [];            // every deliver() call (audit-grade, sanitized shape)
    this._failNext = null;      // { kind, message }
    this._failures = new Map(); // recipientId -> { kind, message, remaining }
    this._failAll = null;       // { kind, message }
  }

  /** Inject a one-shot failure on the next deliver() call. */
  failNext(kind = 'transient', message = 'injected temporary failure') {
    this._failNext = { kind, message };
    return this;
  }

  /** Inject N failures for a specific recipient. kind: 'transient' | 'permanent'. */
  failFor(recipientId, { kind = 'transient', message = 'injected failure', times = 1 } = {}) {
    this._failures.set(String(recipientId), { kind, message, remaining: times });
    return this;
  }

  /** Fail every deliver() call. */
  failAll(kind = 'transient', message = 'injected failure') {
    this._failAll = { kind, message };
    return this;
  }

  clearFailures() {
    this._failNext = null;
    this._failAll = null;
    this._failures.clear();
    return this;
  }

  _makeError(kind, message) {
    return kind === 'permanent' ? new PermanentError(message) : new TransientError(message);
  }

  /** @param {unknown} notification */
  async deliver(notification) {
    this.calls.push(structuredClone(notification));
    const recipientId = notification && typeof notification === 'object' ? String(notification.recipient_id ?? '') : '';

    if (this._failNext) {
      const f = this._failNext;
      this._failNext = null;
      throw this._makeError(f.kind, f.message);
    }
    if (this._failAll) throw this._makeError(this._failAll.kind, this._failAll.message);

    const perRecipient = this._failures.get(recipientId);
    if (perRecipient && perRecipient.remaining > 0) {
      perRecipient.remaining -= 1;
      if (perRecipient.remaining === 0) this._failures.delete(recipientId);
      throw this._makeError(perRecipient.kind, perRecipient.message);
    }

    this.inbox.push(structuredClone(notification));
    return;
  }

  /** Delivered notifications for a recipient. */
  inboxFor(recipientId) {
    return this.inbox.filter((n) => String(n.recipient_id) === String(recipientId));
  }
}
