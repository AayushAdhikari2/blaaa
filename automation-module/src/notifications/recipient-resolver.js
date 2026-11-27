/**
 * Recipient resolution for Process 01.
 *
 * Roles allowed: reception + admin ONLY. Doctors, lab staff, anonymous users and patients
 * are never recipients. Recipient IDs come from trusted server-side queries (production:
 * `profiles` table via service-role; local V1: synthetic mock directory). Recipients are
 * NEVER taken from the event or from browser input. Eligibility is re-checked at processing
 * time, immediately before notification creation/delivery.
 */

export const ELIGIBLE_ROLES_APPOINTMENT_REQUESTED = Object.freeze(['reception', 'admin']);

export class RecipientResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecipientResolutionError';
    this.transient = false;
  }
}

/**
 * @typedef {object} StaffRecipient
 * @property {string} id        staff identity (production: profiles.id UUID; V1: synthetic UUID)
 * @property {string} role      'reception' | 'admin' (filtered) | 'doctor' | 'lab' ...
 */

/**
 * RecipientProvider adapter contract.
 * @typedef {object} RecipientProvider
 * @property {() => Promise<StaffRecipient[]>} listStaff   trusted server-side staff directory
 * @property {(id: string) => Promise<StaffRecipient | null>} getStaff
 */

/** @param {StaffRecipient | null | undefined} recipient @param {string[]} roles */
export function isEligibleRecipient(recipient, roles = ELIGIBLE_ROLES_APPOINTMENT_REQUESTED) {
  if (!recipient || typeof recipient.id !== 'string' || recipient.id === '') return false;
  if (recipient.active === false) return false;
  return roles.includes(recipient.role);
}

/**
 * Resolve eligible staff. `roles` always defaults to the Process-01 allow-list;
 * callers cannot widen it with untrusted input.
 * @param {RecipientProvider} provider
 * @param {{ roles?: string[] }} [options]
 * @returns {Promise<StaffRecipient[]>}
 */
export async function resolveRecipients(provider, options = {}) {
  const roles = options.roles ?? ELIGIBLE_ROLES_APPOINTMENT_REQUESTED;
  // Hard allow-list intersection: can never include doctor/lab/etc.
  const safeRoles = roles.filter((r) => ELIGIBLE_ROLES_APPOINTMENT_REQUESTED.includes(r));
  if (safeRoles.length === 0) return [];

  const staff = await provider.listStaff();
  return staff
    .filter((s) => isEligibleRecipient(s, safeRoles))
    .map((s) => ({ id: String(s.id), role: s.role }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Re-check eligibility at processing time. A recipient who was eligible at resolution
 * but no longer is (role changed, deactivated, removed) must not receive a notification.
 * @param {RecipientProvider} provider
 * @param {string} recipientId
 */
export async function recheckEligibility(provider, recipientId, roles = ELIGIBLE_ROLES_APPOINTMENT_REQUESTED) {
  const staff = await provider.getStaff(String(recipientId));
  return isEligibleRecipient(staff, roles);
}
