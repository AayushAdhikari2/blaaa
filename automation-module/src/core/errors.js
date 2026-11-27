/** Base automation error. `transient` drives retry classification; `code` is stable for tooling. */
export class AutomationError extends Error {
  constructor(message, { code = 'AUTOMATION_ERROR', transient = false, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.transient = transient;
  }
}

/** Event failed validation. Never transient. */
export class ValidationError extends AutomationError {
  constructor(message, details = []) {
    super(message, { code: 'VALIDATION_ERROR', transient: false });
    this.details = details;
  }
}

/** Event type is not known to this engine. Never transient. */
export class UnknownEventError extends AutomationError {
  constructor(eventType) {
    super(`Unknown event type: ${String(eventType)}`, { code: 'UNKNOWN_EVENT_TYPE', transient: false });
    this.eventType = eventType;
  }
}

/** Transient (retryable) failure, e.g. temporary downstream outage. */
export class TransientError extends AutomationError {
  constructor(message, { code = 'TRANSIENT_ERROR', cause } = {}) {
    super(message, { code, transient: true, cause });
  }
}

/** Permanent (non-retryable) failure, e.g. misconfiguration. */
export class PermanentError extends AutomationError {
  constructor(message, { code = 'PERMANENT_ERROR', cause } = {}) {
    super(message, { code, transient: false, cause });
  }
}
