import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventSimulator } from '../src/adapters/mock/event-simulator.js';
import { validateEvent } from '../src/core/event-validator.js';
import { ManualClock } from '../src/core/clock.js';

test('synthetic appointment request: valid, deterministic, no patient data', () => {
  const sim = new EventSimulator({ clock: new ManualClock('2024-06-01T12:00:00.000Z') });
  const a = sim.generateAppointmentRequested({ appointmentId: '100001', occurredAt: '2024-06-01T12:00:00.000Z' });
  const b = sim.generateAppointmentRequested({ appointmentId: '100001', occurredAt: '2024-06-01T12:00:00.000Z' });

  assert.equal(validateEvent(a.event).valid, true);
  assert.equal(a.event.event_id, b.event.event_id); // deterministic
  assert.equal(a.event.payload.appointment_id, '100001');
  assert.equal(a.event.source_id, '100001');
  assert.ok(!('name' in a.event) && !('phone' in a.event.payload));
  assert.ok(!JSON.stringify(a.event).toLowerCase().includes('patient'));
  assert.equal(a.syntheticAppointment.synthetic, true);
});
