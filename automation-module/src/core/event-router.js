import { EVENT_TYPE_APPOINTMENT_REQUESTED } from './event-validator.js';
import { UnknownEventError } from './errors.js';

/**
 * Event router: event_type → workflow handler. Not a generic workflow builder;
 * explicit registration, hospital-business-event focused, future extensibility via register().
 */
export class EventRouter {
  constructor() {
    this._handlers = new Map();
  }

  /** @param {string} eventType @param {(event: object, ctx: object) => Promise<unknown>} handler */
  register(eventType, handler) {
    if (this._handlers.has(eventType)) throw new Error(`handler already registered for ${eventType}`);
    this._handlers.set(eventType, handler);
    return this;
  }

  has(eventType) {
    return this._handlers.has(eventType);
  }

  /** @throws {UnknownEventError} */
  async route(event, ctx) {
    const handler = this._handlers.get(event.event_type);
    if (!handler) throw new UnknownEventError(event.event_type);
    return handler(event, ctx);
  }

  knownTypes() {
    return [...this._handlers.keys()];
  }
}

export { EVENT_TYPE_APPOINTMENT_REQUESTED };
