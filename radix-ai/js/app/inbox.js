/* ===== Notification centre (the bell) ===== Needs the notifications section of setup.sql. Loads after notify.js, before start.js.
   - Notifications are created by the DATABASE when something really happened (see ntf_* triggers). This file only shows them.
   - Live: Supabase Realtime tells us at once; a 45-second check is the safety net if Realtime is blocked (hospital Wi-Fi).
   - Staff only. Starts after login (and after 2FA), stops at log out. Role filtering is done by the database (RLS), not here.
   - Previews never contain patient names (the database only writes token numbers). */
const NT = {pending: [], recent: [], unread: 0, open: false, tab: 'all', mode: 'list', seenAt: null, chan: null, live: false, uid: null, timers: [],
  prefs: {sound: false, vibrate: false, muted_categories: []}, canMore: false, busy: false};
const NT_ICON = {queue: 'doc', appt: 'book', lab: 'lab', pharmacy: 'pha', billing: 'clm', claims: 'clm', ward: 'wrd', admin: 'adm', security: 'sec'};
const NT_GROUPS = [[['queue', 'appt'], 'Queue and appointments'], [['lab'], 'Lab reports'], [['pharmacy'], 'Pharmacy and stock'],
  [['billing', 'claims'], 'Billing and claims'], [['ward'], 'Wards and beds'], [['admin'], 'Admin and staff activity']];
const NT_BELL = 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0';
const ntSvg = d => { const s = document.createElement('span'); s.style.display = 'contents'; s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (d.startsWith('<') ? d : '<path d="' + d + '"/>') + '</svg>'; return s; };   // d = path data or ICONS markup; constant markup only, never user data
const ntCat = k => String(k || '').split('.')[0];
const ntAgo = t => {
  const s = Math.max(0, (Date.now() - new Date(t)) / 1000);
  if (s < 45) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleString([], {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
};

/* ---------- lifecycle ---------- */
function inboxStop() {
  NT.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); NT.timers = [];
  if (NT.chan) { try { sb.removeChannel(NT.chan); } catch (_) {} NT.chan = null; }
  NT.live = false; NT.uid = null; NT.open = false; NT.pending = []; NT.recent = []; NT.unread = 0; NT.seenAt = null; NT.mode = 'list'; NT.tab = 'all';
  document.getElementById('bell')?.remove(); document.getElementById('npanel')?.remove();
  document.removeEventListener('click', ntOutside, true); document.removeEventListener('keydown', ntKey, true);
  ntTitle();
}
async function inboxStart() {
  if (!session || !me) { inboxStop(); return; }
  if (NT.uid === session.user.id && document.getElementById('bell')) return;   // already running for this person
  inboxStop(); NT.uid = session.user.id;
  const bell = h('button', {id: 'bell', class: 'bell', type: 'button', 'aria-label': 'Notifications', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'npanel', onclick: ntToggle},
    ntSvg(NT_BELL), h('span', {class: 'bct', hidden: 'hidden'}));
  const panel = h('div', {id: 'npanel', class: 'npanel', role: 'dialog', 'aria-label': 'Notifications', hidden: 'hidden'});
  const cta = document.querySelector('.nav-cta'); cta.insertBefore(bell, cta.firstChild); cta.append(panel);
  document.addEventListener('click', ntOutside, true); document.addEventListener('keydown', ntKey, true);
  await ntLoadPrefs();
  await ntRefresh(false);
  if (NT.uid !== session?.user.id) return;
  if (sb.channel) {
    try {
      NT.chan = sb.channel('notif-live').on('postgres_changes', {event: '*', schema: 'public', table: 'notifications'}, ntChanged)
        .subscribe(st => { NT.live = st === 'SUBSCRIBED'; });
    } catch (_) { NT.live = false; }
  }
  NT.timers.push(setInterval(() => { if (!document.hidden) ntRefresh(true); }, 45000));
  NT.timers.push(setInterval(() => sb.rpc('notif_maintenance').then(() => {}, () => {}), 3600000));
  sb.rpc('notif_maintenance').then(() => ntRefresh(false), () => {});   // stock/expiry check + tidy-up, then pick up anything it created
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && NT.uid) ntRefresh(true); });
let ntDeb; function ntChanged() { clearTimeout(ntDeb); ntDeb = setTimeout(() => ntRefresh(true), 350); }

/* ---------- data ---------- */
async function ntLoadPrefs() {
  const {data} = await sb.from('notification_preferences').select('sound,vibrate,muted_categories').eq('user_id', session.user.id).maybeSingle();
  if (data) NT.prefs = {sound: !!data.sound, vibrate: !!data.vibrate, muted_categories: data.muted_categories || []};
}
async function ntSavePrefs() {
  const {error} = await sb.from('notification_preferences').upsert({user_id: session.user.id, sound: NT.prefs.sound, vibrate: NT.prefs.vibrate,
    muted_categories: NT.prefs.muted_categories, updated_at: new Date().toISOString()});
  if (error) toast('Could not save your notification settings: ' + errText(error), true); else toast('Notification settings saved.');
  return !error;
}
async function ntRefresh(announce) {
  if (!NT.uid || NT.busy) return; NT.busy = true;
  try {
    const {data, error} = await sb.rpc('notif_list', {p_limit: 50});
    if (error || !data) return;
    NT.pending = data.pending || []; NT.recent = data.recent || []; NT.unread = data.unread || 0; NT.canMore = NT.recent.length >= 50;
    const all = NT.pending.concat(NT.recent);
    const fresh = NT.seenAt == null ? [] : all.filter(n => !n.read && +new Date(n.created_at) > NT.seenAt).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (all.length) NT.seenAt = Math.max(NT.seenAt || 0, ...all.map(n => +new Date(n.created_at)));
    else if (NT.seenAt == null) NT.seenAt = 0;
    ntBadge();
    const sig = JSON.stringify(all.map(n => [n.id, n.read, n.created_at])) + Math.floor(Date.now() / 60000);   // redraw only when something changed (keeps keyboard focus)
    if (NT.open && NT.mode === 'list' && sig !== NT.sig) ntRender();
    NT.sig = sig;
    if (announce && fresh.length) ntAnnounce(fresh);
  } finally { NT.busy = false; }
}
function ntAnnounce(list) {
  const TYPE = {info: 'info', success: 'success', warning: 'warning', critical: 'error'};
  list.slice(-3).forEach(n => UI.toast(n.title + (n.body ? ' · ' + n.body : ''), TYPE[n.severity] || 'info', {timeout: n.severity === 'critical' ? 12000 : 7000}));
  if (list.length > 3) UI.toast('and ' + (list.length - 3) + ' more notifications', 'info');
  if (NT.prefs.sound) ntBeep(list.some(n => n.severity === 'critical'));
  if (NT.prefs.vibrate && navigator.vibrate) { try { navigator.vibrate(list.some(n => n.severity === 'critical') ? [120, 60, 120] : 120); } catch (_) {} }
}
let ntCtx;
function ntBeep(urgent) {
  try {
    ntCtx = ntCtx || new (window.AudioContext || window.webkitAudioContext)(); if (ntCtx.state === 'suspended') ntCtx.resume();
    [0, 0.16].slice(0, urgent ? 2 : 1).forEach(off => {
      const o = ntCtx.createOscillator(), g = ntCtx.createGain(); o.type = 'sine'; o.frequency.value = urgent ? 660 : 880;
      g.gain.setValueAtTime(0.0001, ntCtx.currentTime + off); g.gain.exponentialRampToValueAtTime(0.18, ntCtx.currentTime + off + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ntCtx.currentTime + off + 0.14);
      o.connect(g); g.connect(ntCtx.destination); o.start(ntCtx.currentTime + off); o.stop(ntCtx.currentTime + off + 0.15);
    });
  } catch (_) {}
}
function ntTitle() {
  document.title = (NT.unread > 0 ? '(' + (NT.unread > 99 ? '99+' : NT.unread) + ') ' : '') + 'RADIX AI';
  try { if (NT.unread > 0) navigator.setAppBadge?.(NT.unread); else navigator.clearAppBadge?.(); } catch (_) {}
}
function ntBadge() {
  const b = document.querySelector('#bell .bct'); if (!b) return;
  b.hidden = NT.unread < 1; b.textContent = NT.unread > 99 ? '99+' : String(NT.unread);
  b.classList.toggle('crit', NT.pending.concat(NT.recent).some(n => !n.read && n.severity === 'critical'));
  document.getElementById('bell').setAttribute('aria-label', NT.unread > 0 ? 'Notifications, ' + NT.unread + ' unread' : 'Notifications');
  ntTitle();
}

/* ---------- panel ---------- */
function ntToggle() { NT.open ? ntClose(true) : ntOpen(); }
function ntOpen() {
  NT.open = true; NT.mode = 'list'; const p = document.getElementById('npanel'); p.hidden = false;
  document.getElementById('bell').setAttribute('aria-expanded', 'true'); ntRender(); ntRefresh(false);
  (p.querySelector('[data-first]') || p).focus?.();
}
function ntClose(refocus) {
  NT.open = false; const p = document.getElementById('npanel'); if (p) p.hidden = true;
  const b = document.getElementById('bell'); if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus) b.focus(); }
}
function ntOutside(e) { if (NT.open && !e.target.closest('#npanel, #bell, dialog')) ntClose(false); }
function ntKey(e) { if (e.key === 'Escape' && NT.open && !document.querySelector('dialog[open]')) { e.stopPropagation(); ntClose(true); } }

function ntItem(n) {
  const unread = !n.read, cat = ntCat(n.kind);
  const main = h('button', {type: 'button', 'data-k': 'i' + n.id, class: 'nitem sev-' + n.severity + (unread ? ' unread' : ''), onclick: () => ntOpenItem(n)},
    h('span', {class: 'ni'}, ntSvg(ICONS[NT_ICON[cat]] || ICONS.more)),
    h('span', {class: 'nt'}, h('div', {class: 'nti'}, n.title), n.body ? h('div', {class: 'nbo'}, n.body) : null, h('div', {class: 'ntm'}, ntAgo(n.created_at))),
    h('span', {class: 'dot', 'aria-hidden': 'true'}));
  main.setAttribute('aria-label', (unread ? 'Unread. ' : '') + n.title + '. ' + (n.body || '') + ' ' + ntAgo(n.created_at));
  const tog = h('button', {type: 'button', class: 'nrd', 'data-k': 'r' + n.id, onclick: () => ntSetRead([n], unread), 'aria-label': (unread ? 'Mark as read: ' : 'Mark as unread: ') + n.title}, unread ? 'Mark read' : 'Mark unread');
  return h('div', {class: 'nrow'}, main, tog);
}
function ntRender() {
  const p = document.getElementById('npanel'); if (!p) return;
  const fk = p.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;   // keep keyboard focus across a redraw
  ntDraw(p); if (fk) p.querySelector('[data-k="' + fk + '"]')?.focus();
}
function ntDraw(p) {
  const closeBtn = h('button', {type: 'button', class: 'iconbtn', 'data-k': 'close', 'aria-label': 'Close notifications', onclick: () => ntClose(true)}, ntSvg('M18 6 6 18M6 6l12 12'));
  if (NT.mode === 'settings') { ntRenderSettings(p, closeBtn); return; }
  const gear = h('button', {type: 'button', class: 'iconbtn', 'data-k': 'gear', 'aria-label': 'Notification settings', title: 'Settings', onclick: () => { NT.mode = 'settings'; ntRender(); }}, ntSvg(ICONS.adm));
  const markAll = h('button', {type: 'button', class: 'btn ghost sm', 'data-k': 'markall', onclick: ntMarkAll}, 'Mark all read'); markAll.disabled = NT.unread < 1;
  const head = h('div', {class: 'nhead'}, h('h2', null, 'Notifications'), markAll, gear, closeBtn);
  const tabs = h('div', {class: 'ntabs', role: 'tablist'}, ...[['all', 'All'], ['unread', 'Unread' + (NT.unread ? ' (' + NT.unread + ')' : '')]].map(([k, l]) =>
    h('button', {type: 'button', role: 'tab', 'data-k': 'tab' + k, 'aria-selected': NT.tab === k ? 'true' : 'false', onclick: () => { NT.tab = k; ntRender(); }}, l)));
  const keep = n => NT.tab === 'all' || !n.read;
  const pend = NT.pending.filter(keep), rec = NT.recent.filter(keep);
  const body = h('div', {class: 'nbody'});
  if (pend.length) body.append(h('div', {class: 'nsec'}, 'Needs action (' + pend.length + ')'), ...pend.map(ntItem));
  if (rec.length) body.append(h('div', {class: 'nsec'}, pend.length ? 'Earlier' : NT.tab === 'unread' ? 'Unread' : 'Recent'), ...rec.map(ntItem));
  if (!pend.length && !rec.length) body.append(h('div', {class: 'nempty'}, ntSvg(NT_BELL), NT.tab === 'unread' ? 'You are all caught up.' : 'No notifications yet. New lab reports, prescriptions, stock alerts and other updates for your role will appear here.'));
  if (NT.canMore && NT.tab === 'all') body.append(h('button', {type: 'button', class: 'btn ghost sm nmore', 'data-k': 'more', onclick: e => busy(e.target, 'Loading…', ntMore)}, 'Load older'));
  p.replaceChildren(head, tabs, body);
  closeBtn.setAttribute('data-first', '');
}
function ntRenderSettings(p, closeBtn) {
  const back = h('button', {type: 'button', class: 'iconbtn', 'data-k': 'back', 'aria-label': 'Back to notifications', onclick: () => { NT.mode = 'list'; ntRender(); }}, ntSvg('M15 18l-6-6 6-6'));
  const head = h('div', {class: 'nhead'}, back, h('h2', null, 'Notification settings'), closeBtn);
  const chk = (label, on, fn, id) => { const c = h('input', {type: 'checkbox', id}); c.checked = on; c.onchange = () => fn(c.checked); return h('label', {class: 'chk', for: id}, c, label); };
  const sound = chk('Play a sound for new notifications', NT.prefs.sound, async v => { NT.prefs.sound = v; if (v) ntBeep(false); await ntSavePrefs(); }, 'np-sound');
  const vib = chk('Vibrate on phones and tablets', NT.prefs.vibrate, async v => { NT.prefs.vibrate = v; if (v && navigator.vibrate) navigator.vibrate(120); await ntSavePrefs(); }, 'np-vib');
  const groups = NT_GROUPS.filter(([cats]) => me.role === 'admin' || !cats.includes('admin')).map(([cats, label], i) => chk(label, !cats.every(c => NT.prefs.muted_categories.includes(c)), async v => {
    const m = new Set(NT.prefs.muted_categories); cats.forEach(c => v ? m.delete(c) : m.add(c)); NT.prefs.muted_categories = [...m];
    if (await ntSavePrefs()) ntRefresh(false);
  }, 'np-g' + i));
  p.replaceChildren(head, h('div', {class: 'nbody'}, h('div', {class: 'nset'},
    h('h3', null, 'Alerts'), sound, vib,
    h('h3', null, 'Show me notifications about'), h('div', {class: 'hint'}, 'Security alerts and critical stock problems are always shown.'), ...groups)));
  closeBtn.setAttribute('data-first', '');
}

/* ---------- actions ---------- */
async function ntSetRead(list, read) {
  const ids = list.map(n => n.id); list.forEach(n => n.read = read);
  NT.unread = NT.pending.concat(NT.recent).filter(n => !n.read).length; ntBadge(); if (NT.open) ntRender();
  const {error} = await sb.rpc('notif_mark', {p_ids: ids, p_read: read});
  if (error) { toast('Could not update the notification: ' + errText(error), true); ntRefresh(false); }
}
async function ntMarkAll() {
  [...NT.pending, ...NT.recent].forEach(n => n.read = true); NT.unread = 0; ntBadge(); ntRender();
  const {error} = await sb.rpc('notif_mark_all_read');
  if (error) { toast('Could not mark all as read: ' + errText(error), true); ntRefresh(false); } else toast('All notifications marked as read.');
}
async function ntMore() {
  const last = NT.recent[NT.recent.length - 1]; if (!last) return;
  const {data, error} = await sb.rpc('notif_list', {p_limit: 50, p_before: last.id});
  if (error) { toast('Could not load older notifications: ' + errText(error), true); return; }
  const more = data.recent || []; NT.recent = NT.recent.concat(more); NT.canMore = more.length >= 50; ntRender();
}
function ntOpenItem(n) {
  if (!n.read) ntSetRead([n], true);
  ntClose(false);
  if (!n.view) return;
  if (tabs().some(t => t[0] === n.view)) go(n.view); else UI.toast('That screen is not available for your role.', 'info');
}

/* ---------- safety net: unexpected errors show a message, and the admin is told (screen name + error code only, never details) ---------- */
let ntErrAt = 0;
function ntUnexpected(code) {
  UI.toast('Something went wrong. Please try again. If it keeps happening, tell your admin.', 'error');
  if (!session || !me || Date.now() - ntErrAt < 60000) return; ntErrAt = Date.now();
  sb.rpc('notif_report_error', {p_where: String(view || 'app'), p_code: String(code || 'unknown')}).then(() => {}, () => {});
}
addEventListener('unhandledrejection', e => { const r = e.reason; if (r && /AbortError|NetworkError|Failed to fetch|Load failed/i.test((r.name || '') + ' ' + (r.message || ''))) return; ntUnexpected((r && (r.code || r.name)) || 'rejection'); });
addEventListener('error', e => { if (!e.filename || /ResizeObserver/i.test(e.message || '')) return; ntUnexpected((e.error && e.error.name) || 'error'); });
