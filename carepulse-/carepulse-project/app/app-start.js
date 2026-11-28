/* ===== boot: runs last, after every screen file is loaded ===== */
let booting = false;
async function boot(s) {
  if (booting) return; booting = true;
  try {
    session = s; me = null;
    if (s) {
      const r = await sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
      me = r.data;
      if (r.error) $('#lerr').textContent = 'Could not read your role: ' + r.error.message + ' (did you run setup.sql?)';
      else if (!me) $('#lerr').textContent = 'Logged in, but this account has no role yet. Run staff-setup.sql with this email.';
      if (me) { SET = await loadSettings(); if (await gate()) { resetIdle(); return; } }   // gate() puts up the 2FA screen
    }
    mountFeedback(); resetIdle();
    go(me ? tabs()[0][0] : (['book', 'staff', 'board'].includes(view) ? view : 'pat'));
  } finally { booting = false; }
}

// Views that contain forms are not refreshed automatically (typing would be lost). Everything else refreshes every 5 s.
const NOREFRESH = new Set(['adm', 'sec', 'wrd', 'clm', 'staff', 'book']);
setInterval(() => {
  if (document.hidden || NOREFRESH.has(view) || !$('#mfa').hidden) return;
  if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) render();
}, 5000);

(async () => {
  await loadDocs(); fillStaffForm();
  // setTimeout: calling Supabase inside this callback without it can freeze the login (known supabase-js deadlock)
  sb.auth.onAuthStateChange((ev, s) => setTimeout(() => {
    if (!['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(ev)) { if (s) session = s; return; }
    if (ev === 'SIGNED_IN' && me && s && session && session.user.id === s.user.id) { session = s; return; }   // tab refocus, not a new login
    boot(s);
  }, 0));
})();
