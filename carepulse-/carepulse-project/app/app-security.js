/* ===== step 9 (screens): two-factor login, Security tab, idle logout ===== and step 10: staff feedback button ===== */

/* ---------- two-factor (authenticator app, TOTP) ---------- */
const totpFactors = async () => ((await sb.auth.mfa.listFactors()).data?.totp) || [];   // verified factors only

// Returns true if it put a blocking screen up (code entry or forced set-up). The caller must then NOT open the app.
async function gate() {
  const {data: aal} = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') { await showChallenge(); return true; }
  if (SET.require_mfa === 'true' && !(await totpFactors()).length) { await showEnroll(); return true; }
  return false;
}
function lockScreen(title, node) {
  document.querySelectorAll('main > section').forEach(x => x.hidden = x.id !== 'mfa');
  $('#nav').replaceChildren(); $('#out').hidden = false; $('#who').textContent = me ? me.full_name + ' · ' + me.role : '';
  $('#ptitle').textContent = 'Security'; $('#h1').textContent = title; $('#sub').textContent = 'This clinic protects staff logins with an authenticator app.';
  $('#mfah').textContent = title; $('#mfabody').replaceChildren(node);
}
async function showChallenge() {
  const f = (await totpFactors())[0];
  const code = h('input', {inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', placeholder: '6-digit code'});
  const err = h('div', {class: 'err'});
  const go = h('button', {class: 'btn full', onclick: e => busy(e.target, 'Checking…', async () => {
    const {error} = await sb.auth.mfa.challengeAndVerify({factorId: f.id, code: code.value.trim()});
    if (error) { err.textContent = 'That code is not right. Check the time on your phone and try again.'; code.select(); return; }
    await boot((await sb.auth.getSession()).data.session);
  })}, 'Verify');
  code.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
  lockScreen('Enter your code', h('div', null, h('p', {class: 'muted'}, 'Open your authenticator app and type the 6-digit code for Carepulse.'), code, go, err,
    h('p', {class: 'muted', style: 'font-size:12px;margin-top:12px'}, 'Lost your phone? Ask an admin to reset your 2FA.')));
  code.focus();
}
// The set-up widget is used on the forced screen and on the Security tab.
async function enrollUI(onDone) {
  const {data, error} = await sb.auth.mfa.enroll({factorType: 'totp', friendlyName: 'Carepulse ' + Date.now()});
  if (error) return h('div', {class: 'err'}, 'Could not start set-up: ' + error.message + ' (Supabase > Authentication > MFA must allow TOTP).');
  const code = h('input', {inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code from the app'});
  const err = h('div', {class: 'err'});
  return h('div', null,
    h('ol', {class: 'muted', style: 'padding-left:18px;font-size:13px'}, h('li', null, 'Install an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis…).'),
      h('li', null, 'Scan this picture, or type the key by hand.'), h('li', null, 'Type the 6-digit code it shows.')),
    h('img', {src: data.totp.qr_code, alt: 'QR code for your authenticator app', width: '180', height: '180', style: 'display:block;margin:10px 0'}),
    h('div', {class: 'muted', style: 'font-size:12px;word-break:break-all'}, 'Key: ' + data.totp.secret),
    h('label', null, 'Code'), code,
    h('button', {class: 'btn full', onclick: e => busy(e.target, 'Checking…', async () => {
      const r = await sb.auth.mfa.challengeAndVerify({factorId: data.id, code: code.value.trim()});
      if (r.error) { err.textContent = 'That code is not right. Try the next one.'; return; }
      toast('Two-factor login is on.'); await onDone();
    })}, 'Turn on'), err);
}
async function showEnroll() {
  lockScreen('Set up two-factor login', h('div', null, h('p', {class: 'muted'}, 'Your admin requires an authenticator app for every staff login. This takes one minute.'), await enrollUI(async () => boot((await sb.auth.getSession()).data.session))));
}

/* ---------- Security tab ---------- */
async function renderSec() {
  const fs = await totpFactors(), box = $('#secbody');
  if (fs.length) {
    box.replaceChildren(h('p', null, h('span', {class: 'paid'}, '✓ On'), ' — your login needs a code from your authenticator app.'),
      h('button', {class: 'btn ghost sm', onclick: async e => {
        if (SET.require_mfa === 'true') { toast('The clinic requires two-factor, so it cannot be removed.', true); return; }
        if (!confirm('Remove two-factor login from your account?')) return;
        await busy(e.target, 'Removing…', async () => { const {error} = await sb.auth.mfa.unenroll({factorId: fs[0].id}); if (error) toast(error.message, true); else { toast('Removed.'); renderSec(); } });
      }}, 'Remove'));
  } else {
    box.replaceChildren(h('p', null, h('span', {class: 'due'}, 'Off'), ' — anyone with your password can log in as you.'),
      h('button', {class: 'btn', onclick: async e => { e.target.hidden = true; box.append(await enrollUI(async () => { await go('sec'); })); }}, 'Set up authenticator app'));
  }
}

/* ---------- log out after 15 minutes of no activity (shared reception computers!) ---------- */
const IDLE_MIN = 15; let idleT;
function resetIdle() {
  clearTimeout(idleT);
  if (!session) return;
  idleT = setTimeout(async () => { await sb.auth.signOut(); toast('You were logged out after ' + IDLE_MIN + ' minutes without activity.'); }, IDLE_MIN * 60000);
}
['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev => addEventListener(ev, resetIdle, {passive: true}));

/* ---------- staff feedback button (pilot) ---------- */
function mountFeedback() {
  $('#fbbtn')?.remove(); $('#fbbox')?.remove();
  if (!me) return;
  const kind = h('select', null, ...[['confusing', 'Something is confusing'], ['bug', 'Something is broken'], ['idea', 'Idea'], ['praise', 'This works well']].map(([v, l]) => h('option', {value: v}, l)));
  const msg = h('textarea', {rows: '4', maxlength: '1000', placeholder: 'What happened? What did you expect?'});
  const err = h('div', {class: 'err'});
  const box = h('div', {id: 'fbbox', class: 'fbbox', hidden: 'hidden'}, h('b', null, 'Send feedback'), h('label', null, 'Type'), kind, h('label', null, 'Message'), msg,
    h('div', {class: 'inl'}, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Sending…', async () => {
      if (msg.value.trim().length < 3) { err.textContent = 'Please write a few words.'; return; }
      const {error} = await sb.from('feedback').insert({role: me.role, screen: view, kind: kind.value, message: msg.value.trim()});
      if (error) { err.textContent = error.message; return; }
      msg.value = ''; err.textContent = ''; box.hidden = true; toast('Thank you. Your feedback was saved.');
    })}, 'Send'), h('button', {class: 'btn ghost sm', onclick: () => box.hidden = true}, 'Cancel')), err);
  document.body.append(h('button', {id: 'fbbtn', class: 'fbbtn', onclick: () => { box.hidden = !box.hidden; if (!box.hidden) msg.focus(); }}, 'Feedback'), box);
}
