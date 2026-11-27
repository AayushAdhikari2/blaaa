/**
 * Synthetic staff directory for local V1 (spec section 10 "Mock implementation").
 *
 * Mirrors Carepulse production shape: staff identity = profiles.id (here synthetic UUIDs),
 * role in reception|doctor|lab|admin. Includes negative-test doctor + lab accounts.
 * NO real hospital data. Production resolves via trusted server-side queries against
 * `profiles` (see src/adapters/supabase/ + db/proposals/). Service-role key never in browser.
 */

const SYNTHETIC_STAFF = [
  { id: '11111111-1111-4111-8111-111111111111', role: 'reception', active: true, label: 'synthetic reception 1' },
  { id: '22222222-2222-4222-8222-222222222222', role: 'reception', active: true, label: 'synthetic reception 2' },
  { id: '33333333-3333-4333-8333-333333333333', role: 'admin', active: true, label: 'synthetic admin 1' },
  { id: '44444444-4444-4444-8444-444444444444', role: 'admin', active: true, label: 'synthetic admin 2' },
  // Negative-test accounts: must NEVER receive appointment.requested notifications.
  { id: '55555555-5555-4555-8555-555555555555', role: 'doctor', active: true, label: 'synthetic doctor (negative test)' },
  { id: '66666666-6666-4666-8666-666666666666', role: 'lab', active: true, label: 'synthetic lab (negative test)' },
  // Inactive reception account: must NOT receive notifications.
  { id: '77777777-7777-4777-8777-777777777777', role: 'reception', active: false, label: 'synthetic inactive reception (negative test)' },
];

export class MockRecipientProvider {
  constructor(initialStaff = SYNTHETIC_STAFF) {
    this._staff = initialStaff.map((s) => ({ ...s }));
  }

  /** @returns {Promise<Array<{id:string, role:string, active?:boolean}>>} trusted server-side staff */
  async listStaff() {
    return this._staff.map((s) => ({ id: s.id, role: s.role, active: s.active !== false }));
  }

  /** @returns {Promise<{id:string, role:string, active?:boolean} | null>} */
  async getStaff(id) {
    const found = this._staff.find((s) => s.id === String(id));
    return found ? { id: found.id, role: found.role, active: found.active !== false } : null;
  }

  // ---- test/demo mutators (never exposed to browser clients) ----
  addStaff(staff) { this._staff.push({ ...staff }); }
  removeStaff(id) { this._staff = this._staff.filter((s) => s.id !== id); }
  setRole(id, role) { const s = this._staff.find((x) => x.id === id); if (s) s.role = role; }
  setActive(id, active) { const s = this._staff.find((x) => x.id === id); if (s) s.active = active; }
}

/** Immutable view of the synthetic directory (safe fields only; no names in our records). */
export function syntheticStaffSnapshot(provider) {
  return provider.listStaff();
}

export { SYNTHETIC_STAFF };
