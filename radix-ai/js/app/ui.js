/* ===== RADIX AI shared UI: ONE toast system and ONE dialog system for the whole app =====
   Loaded first (before app.js). Nothing else may create its own popups; do not call alert(), confirm() or prompt().

   toast('Saved')                              green success message (kept for old code)
   toast('Could not save', true)               red error message (kept for old code)
   UI.toast(msg, type, {timeout, id})          type: success | error | warning | info | loading
   const t = UI.toast('Uploading…', 'loading'); … t.update('Done', 'success') or t.close()
   await ask({title, message, confirm:'Discharge', danger:true})        -> true / false
   await askText({title, message, label, required:true, multiline:true}) -> string, or null if cancelled
   UI.modal('Label', node)                      frame for form popups (focus trap, Escape, backdrop click, focus return)

   - The same message shown twice at once is merged into one toast with a counter (duplicate prevention).
   - Errors stay 8 s, others 4 s; loading stays until updated. Hover or keyboard focus pauses the timer. Every toast has a close button.
   - Dialogs use the native <dialog> element: focus is trapped, Escape cancels, the page behind is inert, focus returns afterwards.
   - Dangerous actions (danger:true) start with focus on Cancel so a stray Enter cannot confirm them. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    success: 'M20 6 9 17l-5-5',
    error: 'M12 8v5M12 16.5v.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    warning: 'M12 9v4M12 17v.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    info: 'M12 16v-5M12 8v.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    critical: 'M12 8v5M12 16.5v.01M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z',
    close: 'M18 6 6 18M6 6l12 12'
  };
  const svg = (k, cls) => {
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', cls || 'uico');
    if (k === 'loading') { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 12); c.setAttribute('cy', 12); c.setAttribute('r', 9); c.setAttribute('class', 'spin'); s.append(c); return s; }
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[k] || ICONS.info); s.append(p); return s;
  };
  const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

  /* ---------- toasts ---------- */
  const MAX = 4, LIVE = [];
  let region;
  function mount() {
    if (region && region.isConnected) return region;
    region = document.getElementById('toasts') || el('div'); region.id = 'toasts'; region.className = 'toasts';
    region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Notifications');
    if (!region.isConnected) document.body.append(region);
    return region;
  }
  const dur = t => t === 'error' ? 8000 : t === 'loading' ? 0 : t === 'warning' ? 6000 : 4000;

  function toast(msg, type, opts) {
    if (type === true) type = 'error'; else if (!type || type === false) type = 'success';
    opts = opts || {}; msg = String(msg == null ? '' : msg); if (!msg) return {close() {}, update() {}};
    mount();
    const dup = LIVE.find(x => x.type === type && x.msg === msg && !x.closing);
    if (dup) { dup.count++; dup.badge.textContent = '×' + dup.count; dup.badge.hidden = false; dup.arm(); dup.node.classList.remove('pulse'); void dup.node.offsetWidth; dup.node.classList.add('pulse'); return dup.api; }
    const t = {type, msg, count: 1, closing: false};
    const node = el('div', 'toast t-' + type), txt = el('div', 'tmsg', msg), badge = el('span', 'tcount'), x = el('button', 'tx');
    badge.hidden = true; x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.append(svg('close', 'uico sm'));
    // errors are announced at once (alert); the rest politely (status)
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ico = svg(type); node.append(ico, txt, badge, x);
    t.node = node; t.badge = badge;
    let timer = 0, paused = false, ms = opts.timeout != null ? opts.timeout : dur(type);
    t.arm = () => { clearTimeout(timer); if (ms > 0 && !paused) timer = setTimeout(close, ms); };
    function close() {
      if (t.closing) return; t.closing = true; clearTimeout(timer);
      const i = LIVE.indexOf(t); if (i >= 0) LIVE.splice(i, 1);
      node.classList.add('out'); setTimeout(() => node.remove(), 180);
    }
    t.api = {
      close,
      update(m, ty, o) {   // turn a loading toast into its result
        if (t.closing) return;
        if (m != null) { t.msg = String(m); txt.textContent = t.msg; }
        if (ty) { t.type = ty === true ? 'error' : ty; node.className = 'toast t-' + t.type; node.setAttribute('role', t.type === 'error' ? 'alert' : 'status'); node.replaceChild(svg(t.type), node.firstChild); }
        ms = o && o.timeout != null ? o.timeout : dur(t.type); t.arm();
      }
    };
    x.onclick = close;
    node.addEventListener('mouseenter', () => { paused = true; clearTimeout(timer); });
    node.addEventListener('mouseleave', () => { paused = false; t.arm(); });
    node.addEventListener('focusin', () => { paused = true; clearTimeout(timer); });
    node.addEventListener('focusout', () => { paused = false; t.arm(); });
    LIVE.push(t); region.append(node);
    while (LIVE.filter(z => !z.closing).length > MAX) { const old = LIVE.find(z => !z.closing && z.type !== 'loading'); if (!old) break; old.api.close(); }
    t.arm(); return t.api;
  }

  /* ---------- dialogs ---------- */
  // Tab / Shift+Tab wrap around inside the dialog (the page behind is inert, so focus must never fall out into the browser bar)
  const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapTab(dlg) {
    dlg.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null || x === document.activeElement); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dlg)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  let opening = Promise.resolve();
  function dialog(build) {
    // one dialog at a time: a second request waits for the first
    const run = () => new Promise(resolve => {
      const prevFocus = document.activeElement;
      const dlg = el('dialog', 'dlg'); const id = 'dlg' + Date.now() + Math.floor(Math.random() * 1e4);
      let settled = false;
      const done = v => { if (settled) return; settled = true; try { dlg.close(); } catch (_) { dlg.removeAttribute('open'); } dlg.remove(); try { prevFocus && prevFocus.isConnected && prevFocus.focus(); } catch (_) {} resolve(v); };
      build(dlg, done, id); trapTab(dlg);
      dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });          // Escape
      dlg.addEventListener('click', e => { if (e.target === dlg) done(null); });          // click on the dim background
      document.body.append(dlg);
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      const f = dlg.querySelector('[data-first]'); if (f) f.focus();
    });
    const p = opening.then(run, run); opening = p.catch(() => {}); return p;
  }
  function head(dlg, id, o) {
    dlg.setAttribute('aria-labelledby', id + 't'); dlg.setAttribute('aria-describedby', id + 'd');
    const kind = o.danger ? 'warning' : 'info';
    const hd = el('div', 'dhead'); const ic = el('span', 'dico ' + (o.danger ? 'danger' : '')); ic.append(svg(kind));
    const t = el('h2', null, o.title || 'Please confirm'); t.id = id + 't';
    hd.append(ic, t); dlg.append(hd);
    if (o.message) { const m = el('p', 'dmsg', o.message); m.id = id + 'd'; dlg.append(m); } else { const m = el('span'); m.id = id + 'd'; m.hidden = true; dlg.append(m); }
  }
  /* confirm: resolves true (confirmed) or false (cancelled / Escape / click outside) */
  function ask(o) {
    if (typeof o === 'string') o = {message: o};
    o = o || {};
    return dialog((dlg, done, id) => {
      head(dlg, id, o);
      const bar = el('div', 'dbar'), no = el('button', 'btn ghost', o.cancel || 'Cancel'), yes = el('button', 'btn' + (o.danger ? ' bad' : ''), o.confirm || 'Confirm');
      no.type = yes.type = 'button'; no.onclick = () => done(false); yes.onclick = () => done(true);
      (o.danger ? no : yes).setAttribute('data-first', '');
      bar.append(no, yes); dlg.append(bar);
      dlg.addEventListener('close', () => done(false));
    }).then(v => v === true);
  }
  /* prompt: resolves the typed text, or null when cancelled */
  function askText(o) {
    if (typeof o === 'string') o = {message: o};
    o = o || {};
    return dialog((dlg, done, id) => {
      head(dlg, id, o);
      const inp = o.multiline ? el('textarea') : el('input'); inp.id = id + 'i'; inp.value = o.value == null ? '' : String(o.value);
      if (!o.multiline) inp.type = o.type || 'text'; else inp.rows = 3;
      if (o.min != null) inp.min = o.min; if (o.max != null) inp.max = o.max; if (o.step != null) inp.step = o.step;
      inp.maxLength = o.maxlength || 500; if (o.placeholder) inp.placeholder = o.placeholder; inp.setAttribute('data-first', '');
      const lab = el('label', null, o.label || 'Your answer'); lab.setAttribute('for', inp.id);
      const err = el('div', 'err dmsgerr'); err.setAttribute('role', 'alert');
      const bar = el('div', 'dbar'), no = el('button', 'btn ghost', o.cancel || 'Cancel'), yes = el('button', 'btn' + (o.danger ? ' bad' : ''), o.confirm || 'OK');
      no.type = yes.type = 'button';
      const submit = () => {
        const v = inp.value.trim(); err.textContent = '';
        if (o.required !== false && !v) { err.textContent = o.requiredText || 'Please fill this in.'; inp.focus(); return; }
        const bad = o.validate && o.validate(v); if (bad) { err.textContent = bad; inp.focus(); return; }
        done(v);
      };
      no.onclick = () => done(null); yes.onclick = submit;
      inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !(o.multiline && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); submit(); } });
      bar.append(no, yes); dlg.append(lab, inp, err, bar);
      dlg.addEventListener('close', () => done(null));
    });
  }

  /* modal: the ONE frame for every form-like popup (book appointment, patient card, visit slip, priority…).
     content = node or array of nodes (they bring their own title and buttons). Returns the native <dialog>; call dlg.close() to close it. */
  function modal(label, content, o) {
    o = o || {};
    const dlg = el('dialog', 'dlg modal' + (o.cls ? ' ' + o.cls : '')), prev = document.activeElement;
    dlg.setAttribute('aria-label', label);
    [].concat(content).forEach(c => c && dlg.append(c));
    dlg.addEventListener('close', () => { dlg.remove(); try { prev && prev.isConnected && prev.focus(); } catch (_) {} });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // click on the dim background closes
    trapTab(dlg); document.body.append(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    return dlg;
  }

  /* autoLabel: every form control gets an accessible name. Screens build many fields in script; if one has no <label>, aria-label or title,
     we name it from the label just before it, its placeholder, or the nearest heading. Runs after each screen change. */
  function autoLabel(root) {
    (root || document).querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea').forEach(c => {
      if (c.labels && c.labels.length || c.getAttribute('aria-label') || c.getAttribute('aria-labelledby') || c.title) return;
      let t = c.placeholder || '';
      const prev = c.previousElementSibling; if (!t && prev && prev.tagName === 'LABEL') t = prev.textContent;
      if (!t && c.type === 'date') t = 'Date'; if (!t && c.type === 'file') t = 'Choose file';
      if (!t) { const h = c.closest('.card,.room,.panel,section'); const hd = h && h.querySelector('h2,h3,b'); t = hd ? hd.textContent : ''; }
      if (!t && c.tagName === 'SELECT') t = (c.options[0] && c.options[0].textContent) || 'Choose';
      if (t) c.setAttribute('aria-label', t.trim().slice(0, 80));
    });
  }
  let alq = 0; const queueLabel = () => { if (!alq) alq = requestAnimationFrame(() => { alq = 0; autoLabel(); }); };
  const startLabels = () => { autoLabel(); new MutationObserver(queueLabel).observe(document.body, {childList: true, subtree: true}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startLabels); else startLabels();

  window.UI = {toast, ask, askText, modal, icon: svg, autoLabel};
  window.toast = (msg, bad) => toast(msg, bad ? 'error' : 'success');
  window.ask = ask; window.askText = askText;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
