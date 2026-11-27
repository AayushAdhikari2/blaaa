/**
 * PRODUCTION ADAPTER (prepared, NOT active in V1).
 *
 * Resolves Process-01 recipients from the REAL Carepulse `profiles` table:
 *   select id from profiles where role in ('reception','admin') ...
 *
 * Staff identity = profiles.id (Supabase Auth UUID). Patient identity is NOT Supabase Auth
 * and is never a recipient. Doctors/lab are excluded. Eligibility re-checked at processing time.
 *
 * SECURITY: runs ONLY on a trusted server. The service-role key lives in server-side
 * environment/secret storage (never in browser JS, never in logs). V1 makes NO live calls:
 * the Supabase client must be injected explicitly by trusted server code; nothing here is
 * constructed in the local demo engine. Proposal SQL + RLS in db/proposals/.
 *
 * NOTE: does NOT reuse supabase/functions/admin-staff (that function is staff administration,
 * not an automation processor).
 */

export const PRODUCTION_ELIGIBLE_ROLES = Object.freeze(['reception', 'admin']);
export const PRODUCTION_PROFILES_TABLE = 'profiles';

export class SupabaseRecipientProvider {
  /**
   * @param {{ client: { from: (table: string) => any }, roles?: string[], table?: string }} deps
   *   client: a server-side Supabase client created with the service-role key on a trusted server.
   */
  constructor({ client, roles = PRODUCTION_ELIGIBLE_ROLES, table = PRODUCTION_PROFILES_TABLE }) {
    if (!client || typeof client.from !== 'function') {
      throw new Error('SupabaseRecipientProvider requires an injected server-side Supabase client (trusted server only)');
    }
    this.client = client;
    this.roles = [...roles].filter((r) => PRODUCTION_ELIGIBLE_ROLES.includes(r));
    this.table = table;
  }

  /** @returns {Promise<Array<{id:string, role:string}>>} */
  async listStaff() {
    const { data, error } = await this.client
      .from(this.table)
      .select('id, role')
      .in('role', this.roles); // trusted server-side query; nothing from browser
    if (error) throw new Error(`profiles query failed: ${error.message}`);
    return (data ?? []).map((r) => ({ id: String(r.id), role: r.role, active: true }));
  }

  /** @returns {Promise<{id:string, role:string, active?:boolean} | null>} */
  async getStaff(id) {
    const { data, error } = await this.client
      .from(this.table)
      .select('id, role')
      .eq('id', String(id))
      .maybeSingle();
    if (error) throw new Error(`profiles query failed: ${error.message}`);
    if (!data) return null;
    if (!this.roles.includes(data.role)) return null; // ineligible role → not a recipient
    return { id: String(data.id), role: data.role, active: true };
  }
}
