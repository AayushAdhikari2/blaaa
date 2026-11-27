// Edge Function: admin-staff — create / update / remove staff logins. Only callable by users whose profile role is 'admin'.
// Needs the service-role key, which must never reach the browser, so this runs on Supabase's server.
// Deploy:  supabase functions deploy admin-staff        (SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are provided automatically)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const ROLES = ['admin', 'reception', 'doctor', 'lab'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'Please log in again.' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: me } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role !== 'admin') return json({ error: 'Admins only.' }, 403);

    const b = await req.json();
    const otherAdmins = async (excludeId: string) =>
      (await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').neq('id', excludeId)).count ?? 0;
    const checkRole = () => {
      if (!ROLES.includes(b.role)) return 'Unknown role.';
      if (b.role === 'doctor' && !b.doctor_id) return 'Pick which doctor this login belongs to.';
      if (!b.full_name?.trim()) return 'Name is required.';
      return '';
    };

    if (b.action === 'create') {
      const bad = checkRole() || (!/^\S+@\S+\.\S+$/.test(b.email ?? '') ? 'Enter a valid email.' : '') ||
        ((b.password ?? '').length < 8 ? 'Password must be at least 8 characters.' : '');
      if (bad) return json({ error: bad }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email: b.email.trim(), password: b.password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      const { error: pe } = await admin.from('profiles').insert({
        id: data.user.id, full_name: b.full_name.trim(), role: b.role, doctor_id: b.role === 'doctor' ? b.doctor_id : null,
      });
      if (pe) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: pe.message }, 400); }
      return json({ ok: true });
    }

    if (b.action === 'update') {
      const bad = checkRole() || (b.password && b.password.length < 8 ? 'Password must be at least 8 characters.' : '');
      if (bad) return json({ error: bad }, 400);
      const { data: target } = await admin.from('profiles').select('role').eq('id', b.id).maybeSingle();
      if (!target) return json({ error: 'Staff member not found.' }, 404);
      if (target.role === 'admin' && b.role !== 'admin' && (await otherAdmins(b.id)) === 0)
        return json({ error: 'This is the last admin. Make another admin first.' }, 400);
      const { error } = await admin.from('profiles')
        .update({ full_name: b.full_name.trim(), role: b.role, doctor_id: b.role === 'doctor' ? b.doctor_id : null }).eq('id', b.id);
      if (error) return json({ error: error.message }, 400);
      if (b.password) {
        const { error: pe } = await admin.auth.admin.updateUserById(b.id, { password: b.password });
        if (pe) return json({ error: pe.message }, 400);
      }
      return json({ ok: true });
    }

    if (b.action === 'delete') {
      if (b.id === user.id) return json({ error: 'You cannot remove your own account.' }, 400);
      const { data: target } = await admin.from('profiles').select('role').eq('id', b.id).maybeSingle();
      if (target?.role === 'admin' && (await otherAdmins(b.id)) === 0) return json({ error: 'This is the last admin.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(b.id);   // profile row is removed by ON DELETE CASCADE
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
