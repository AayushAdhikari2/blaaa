/* Headless-browser test of the popup + notification UI. Uses Playwright's Chromium and the stubbed Supabase (no network needed).
   Run: node notify-ui.js     (needs `playwright` installed; prints PASS/FAIL per check, exit code 1 on any failure) */
const {chromium} = require('playwright'), fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), OUT = process.env.SHOTS || path.join(__dirname, 'shots');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};
const srv = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, {'Content-Type': mime[path.extname(f)] || 'application/octet-stream'}); r.end(d); }); });
const STUB = fs.readFileSync(path.join(__dirname, 'stub-browser.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'stub-notify.js'), 'utf8');
let pass = 0, fail = 0; const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' -> ' + extra : '')); } };
async function open(browser, role, vp, url, shared, demo) {
  const ctx = shared || await browser.newContext({viewport: vp, deviceScaleFactor: 1, hasTouch: vp.width < 600, isMobile: vp.width < 600});
  const pg = await ctx.newPage(), errs = []; pg.errs = errs;
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errs.push(m.text()); });
  await pg.route('**/*', rt => { const u = rt.request().url();
    if (demo && u.endsWith('/js/config.js')) return rt.fulfill({contentType: 'text/javascript', body: "const SUPABASE_URL='https://YOUR-PROJECT.supabase.co',SUPABASE_ANON_KEY='x';const PRIVACY_VERSION='t';"});
    if (u.includes('supabase-js')) return rt.fulfill({contentType: 'text/javascript', body: STUB});
    if (u.includes('qrcode-generator')) return rt.fulfill({contentType: 'text/javascript', body: fs.readFileSync(require.resolve('qrcode-generator/qrcode.js'), 'utf8')});
    if (u.includes('fonts.g')) return rt.abort(); return rt.continue(); });
  await pg.addInitScript(r => { window.__ROLE = r; }, role);
  await pg.goto('http://localhost:8123' + url, {waitUntil: 'load'}); await sleep(700); return pg;
}
(async () => {
  fs.mkdirSync(OUT, {recursive: true}); await new Promise(r => srv.listen(8123, r));
  const browser = await chromium.launch();
  const D = {width: 1280, height: 800}, P = {width: 390, height: 780};

  /* ---------- toasts ---------- */
  let pg = await open(browser, 'admin', D, '/app/');
  await pg.evaluate(() => { ['success', 'error', 'warning', 'info'].forEach(t => UI.toast('A ' + t + ' message', t)); });
  ok('four toast types render', await pg.locator('.toast').count() === 4);
  ok('success/error/warning/info classes', (await pg.locator('.toast.t-success,.toast.t-error,.toast.t-warning,.toast.t-info').count()) === 4);
  ok('error toast is role=alert, others role=status', await pg.locator('.toast.t-error[role=alert]').count() === 1 && await pg.locator('.toast.t-info[role=status]').count() === 1);
  await pg.screenshot({path: OUT + '/n1-toasts-desktop.png'});
  await pg.evaluate(() => { UI.toast('A success message', 'success'); UI.toast('A success message', 'success'); });
  ok('duplicate toast is merged with a counter', await pg.locator('.toast.t-success .tcount').first().textContent() === '×3' && await pg.locator('.toast.t-success').count() === 1);
  await pg.evaluate(() => { UI.toast('Fifth', 'info'); UI.toast('Sixth', 'warning'); });
  ok('at most 4 toasts are visible', await pg.locator('.toast:not(.out)').count() <= 4);
  await pg.locator('.toast .tx').first().click(); await sleep(300);
  ok('close button dismisses a toast', await pg.locator('.toast:not(.out)').count() <= 3);
  await pg.evaluate(() => { window.__t = UI.toast('Uploading…', 'loading'); });
  ok('loading toast shows a spinner', await pg.locator('.toast.t-loading .spin').count() === 1);
  await pg.evaluate(() => window.__t.update('Upload finished', 'success', {timeout: 400})); await sleep(900);
  ok('loading toast becomes success then auto-dismisses', await pg.locator('.toast:has-text("Upload finished")').count() === 0);
  await pg.evaluate(() => { toast('legacy ok'); toast('legacy bad', true); });
  ok('legacy toast(msg) and toast(msg,true) still work', await pg.locator('.toast.t-success:has-text("legacy ok")').count() === 1 && await pg.locator('.toast.t-error:has-text("legacy bad")').count() === 1);
  await pg.evaluate(() => UI.toast('Short lived', 'info', {timeout: 300})); await sleep(900);
  ok('toast auto-dismisses', await pg.locator('.toast:has-text("Short lived")').count() === 0);

  /* ---------- dialogs ---------- */
  await pg.evaluate(() => { window.__r = null; ask({title: 'Discharge Ram?', message: 'Bed charges will be added.', confirm: 'Discharge', danger: true}).then(v => window.__r = v); }); await sleep(200);
  ok('confirm dialog opens as a modal', await pg.locator('dialog.dlg[open]').count() === 1 && await pg.evaluate(() => !!document.querySelector('dialog.dlg:modal')));
  ok('dialog is labelled for screen readers', await pg.evaluate(() => { const d = document.querySelector('dialog.dlg'); return !!document.getElementById(d.getAttribute('aria-labelledby')) && !!document.getElementById(d.getAttribute('aria-describedby')); }));
  ok('danger dialog starts with focus on Cancel', await pg.evaluate(() => document.activeElement.textContent === 'Cancel'));
  await pg.screenshot({path: OUT + '/n2-confirm-desktop.png'});
  for (let i = 0; i < 5; i++) await pg.keyboard.press('Tab');
  ok('focus stays trapped inside the dialog (Tab wraps)', await pg.evaluate(() => !!document.activeElement.closest('dialog')));
  await pg.keyboard.press('Shift+Tab'); await pg.keyboard.press('Shift+Tab'); await pg.keyboard.press('Shift+Tab');
  ok('Shift+Tab wraps too', await pg.evaluate(() => !!document.activeElement.closest('dialog')));
  await pg.keyboard.press('Escape'); await sleep(150);
  ok('Escape cancels (false) and closes', await pg.evaluate(() => window.__r) === false && await pg.locator('dialog.dlg').count() === 0);
  await pg.evaluate(() => { window.__r = null; ask({title: 'Record payment?', confirm: 'Payment received'}).then(v => window.__r = v); }); await sleep(150);
  ok('non-danger dialog focuses Confirm', await pg.evaluate(() => document.activeElement.textContent === 'Payment received'));
  await pg.keyboard.press('Enter'); await sleep(150);
  ok('Enter on Confirm resolves true', await pg.evaluate(() => window.__r) === true);
  await pg.evaluate(() => { window.__r = 'x'; ask({title: 'Delete?', danger: true}).then(v => window.__r = v); }); await sleep(150);
  await pg.mouse.click(5, 5); await sleep(150);
  ok('click on the dim background cancels', await pg.evaluate(() => window.__r) === false);
  await pg.evaluate(() => { window.__t = null; askText({title: 'Reject this claim', label: 'Reason', confirm: 'Reject', danger: true}).then(v => window.__t = v); }); await sleep(150);
  await pg.locator('dialog button:has-text("Reject")').click();
  ok('prompt dialog refuses an empty answer', await pg.locator('dialog .dmsgerr').textContent() === 'Please fill this in.' && await pg.evaluate(() => window.__t) === null);
  await pg.locator('dialog input').fill('Not covered'); await pg.keyboard.press('Enter'); await sleep(150);
  ok('prompt resolves the typed text on Enter', await pg.evaluate(() => window.__t) === 'Not covered');
  await pg.evaluate(() => { window.__q = 'x'; askText({title: 'T'}).then(v => window.__q = v); }); await sleep(100); await pg.keyboard.press('Escape'); await sleep(100);
  ok('prompt resolves null when cancelled', await pg.evaluate(() => window.__q) === null);
  await pg.evaluate(() => { window.__o = []; ask({title: 'First'}).then(v => window.__o.push('a' + v)); ask({title: 'Second'}).then(v => window.__o.push('b' + v)); }); await sleep(150);
  ok('two requests never show two dialogs at once', await pg.locator('dialog.dlg[open]').count() === 1 && await pg.locator('dialog h2').textContent() === 'First');
  await pg.keyboard.press('Escape'); await sleep(250); ok('second dialog appears after the first', await pg.locator('dialog h2').textContent() === 'Second'); await pg.keyboard.press('Escape'); await sleep(150);
  ok('no native alert/confirm/prompt left in the app', !(fs.readdirSync(path.join(ROOT, 'js/app')).some(f => /(^|[^.\w])(alert|confirm|prompt)\(/.test(fs.readFileSync(path.join(ROOT, 'js/app', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\b(ask|askText)\(/g, '')))));

  /* ---------- bell ---------- */
  await pg.close(); pg = await open(browser, 'admin', D, '/app/');
  ok('bell is shown for staff with unread count', await pg.locator('#bell .bct').textContent() === '4');
  ok('bell announces the unread count to screen readers', (await pg.locator('#bell').getAttribute('aria-label')).includes('4 unread'));
  ok('page title carries the unread count', (await pg.title()) === '(4) RADIX AI');
  await pg.keyboard.press('Tab'); await pg.focus('#bell'); await pg.keyboard.press('Enter'); await sleep(250);
  ok('keyboard opens the panel and moves focus into it', await pg.locator('#npanel:not([hidden])').count() === 1 && await pg.evaluate(() => !!document.activeElement.closest('#npanel')) && await pg.getAttribute('#bell', 'aria-expanded') === 'true');
  ok('pinned tasks are grouped separately', await pg.locator('.nsec:has-text("Needs action (3)")').count() === 1 && await pg.locator('.nsec:has-text("Earlier")').count() === 1);
  ok('unread items are marked', await pg.locator('.nitem.unread').count() === 4);
  await pg.screenshot({path: OUT + '/n3-bell-desktop.png'});
  await pg.locator('.nrd:has-text("Mark read")').first().click(); await sleep(200);
  ok('mark as read lowers the counter', await pg.locator('#bell .bct').textContent() === '3');
  await pg.locator('.nrd:has-text("Mark unread")').first().click(); await sleep(200);
  ok('mark as unread raises it again', await pg.locator('#bell .bct').textContent() === '4');
  await pg.locator('.ntabs button:has-text("Unread")').click(); await sleep(100);
  ok('Unread tab hides read items', await pg.locator('.nitem').count() === 4);
  await pg.locator('.ntabs button:has-text("All")').click();
  await pg.locator('.nitem:has-text("Payment recorded")').click(); await sleep(300);
  ok('click opens the module (reception) and closes the panel', await pg.locator('#rec:not([hidden])').count() === 1 && await pg.locator('#npanel[hidden]').count() === 1);
  ok('click marked that notification read', await pg.locator('#bell .bct').textContent() === '3');
  await pg.click('#bell'); await sleep(150); await pg.keyboard.press('Escape'); await sleep(100);
  ok('Escape closes the panel and returns focus to the bell', await pg.locator('#npanel[hidden]').count() === 1 && await pg.evaluate(() => document.activeElement.id) === 'bell');
  await pg.click('#bell'); await sleep(150); await pg.locator('button:has-text("Mark all read")').click(); await sleep(250);
  ok('mark all read clears the counter', await pg.locator('#bell .bct[hidden]').count() === 1 && (await pg.title()) === 'RADIX AI');
  ok('a toast confirms mark all read', await pg.locator('.toast:has-text("marked as read")').count() === 1);
  ok('empty Unread tab shows an all-caught-up state', (await pg.locator('.ntabs button:has-text("Unread")').click(), await sleep(100), await pg.locator('.nempty:has-text("all caught up")').count()) === 1);
  await pg.mouse.click(600, 500); await sleep(100);
  ok('clicking outside closes the panel', await pg.locator('#npanel[hidden]').count() === 1);

  /* ---------- live arrival, sound, vibration, settings ---------- */
  await pg.evaluate(() => { window.__beeps = 0; window.__vib = 0; navigator.vibrate = () => { window.__vib++; return true; };
    const A = window.AudioContext; window.AudioContext = function () { const c = new A(); const co = c.createOscillator.bind(c); c.createOscillator = () => { window.__beeps++; return co(); }; return c; }; });
  await pg.click('#bell'); await sleep(150); await pg.locator('button[aria-label="Notification settings"]').click(); await sleep(100);
  ok('settings view lists alert options and categories', await pg.locator('#np-sound').count() === 1 && await pg.locator('#np-vib').count() === 1 && await pg.locator('.nset .chk').count() >= 6);
  await pg.screenshot({path: OUT + '/n4-settings-desktop.png'});
  await pg.locator('#np-sound').check(); await pg.locator('#np-vib').check(); await sleep(200);
  ok('turning sound on gives a sample beep', await pg.evaluate(() => window.__beeps) >= 1);
  await pg.keyboard.press('Escape'); await sleep(100);
  await pg.evaluate(() => { __N.push({id: 7, kind: 'lab.report', severity: 'info', title: 'Lab report ready for review', body: 'T-02 is back in your queue with a report', view: 'doc', created_at: new Date().toISOString(), persistent: false, read: false}); __fire(); });
  await sleep(900);
  ok('a new notification arrives live: badge', await pg.locator('#bell .bct').textContent() === '1');
  ok('...and shows a toast', await pg.locator('.toast:has-text("Lab report ready for review")').count() === 1);
  ok('...plays sound and vibrates (per preference)', await pg.evaluate(() => window.__beeps) >= 2 && await pg.evaluate(() => window.__vib) >= 1);
  await pg.evaluate(() => { __fire(); }); await sleep(900);
  ok('the same notification is not announced twice', await pg.locator('.toast:has-text("Lab report ready for review")').count() === 1);
  await pg.evaluate(() => { __N.push({id: 8, kind: 'security.lookup', severity: 'critical', title: 'Security alert: repeated wrong access codes', body: '', view: 'adm', created_at: new Date().toISOString(), persistent: false, read: false}); __fire(); }); await sleep(900);
  ok('critical alert shows as an error toast and pulses the badge', await pg.locator('.toast.t-error:has-text("Security alert")').count() === 1 && await pg.locator('#bell .bct.crit').count() === 1);
  ok('maintenance (stock/expiry sweep) ran at login', await pg.evaluate(() => __calls.includes('notif_maintenance')));
  ok('no console errors on desktop', pg.errs.length === 0, pg.errs.join(' | '));

  /* ---------- phone ---------- */
  await pg.close(); pg = await open(browser, 'admin', P, '/app/');
  await pg.click('#bell'); await sleep(250);
  const box = await pg.locator('#npanel').boundingBox();
  ok('phone: panel fills the width under the top bar', Math.abs(box.width - 390) < 2 && box.y >= 55 && box.y <= 70 && box.y + box.height <= 781);
  ok('phone: every row control is at least 40px tall', await pg.evaluate(() => [...document.querySelectorAll('#npanel .nrd,#npanel .nitem,#npanel .iconbtn')].every(b => b.getBoundingClientRect().height >= 40)));
  ok('phone: no horizontal scrolling', await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await pg.screenshot({path: OUT + '/n5-bell-phone.png'});
  await pg.keyboard.press('Escape'); await sleep(100);
  await pg.evaluate(() => { UI.toast('Visit completed: Ram', 'success'); UI.toast('Could not save: network', 'error'); }); await sleep(100);
  const tb = await pg.locator('.toasts').boundingBox(); ok('phone: toasts sit under the top bar, inside the screen', tb.x >= 10 && tb.x + tb.width <= 380 && tb.y >= 60);
  await pg.screenshot({path: OUT + '/n6-toasts-phone.png'});
  await pg.evaluate(() => { ask({title: 'Discharge Hari Karki?', message: 'Bed BL-0009 · The bed becomes free and bed charges are added to the bill.', confirm: 'Discharge', danger: true}); }); await sleep(250);
  const db = await pg.locator('dialog.dlg').boundingBox(); ok('phone: dialog fits the screen', db.x >= 0 && db.x + db.width <= 390 && db.y >= 0 && db.y + db.height <= 780);
  await pg.screenshot({path: OUT + '/n7-confirm-phone.png'}); await pg.keyboard.press('Escape');
  ok('no console errors on phone', pg.errs.length === 0, pg.errs.join(' | '));


  /* ---------- booking terms ---------- */
  pg = await open(browser, '', P, '/app/#book');
  ok('booking: terms are read from the database and shown as paragraphs', await pg.locator('#bterms p').count() === 2 && (await pg.locator('#bterms').textContent()).includes('not for emergencies'));
  ok('booking: terms box is keyboard-focusable and labelled', await pg.getAttribute('#bterms', 'tabindex') === '0' && await pg.getAttribute('#bterms', 'aria-labelledby') === 'btermslab');
  await pg.fill('#bn', 'Test Patient'); await pg.fill('#bp', '9800000000'); await pg.click('#bgo'); await sleep(200);
  ok('booking: cannot send without agreeing to the terms', (await pg.locator('#berr').textContent()).includes('terms and conditions') && await pg.evaluate(() => !window.__booked));
  await pg.check('#bcons'); await pg.click('#bgo'); await sleep(300);
  ok('booking: request is sent once the terms are accepted, with a toast', await pg.evaluate(() => !!window.__booked && window.__booked.p_consent === true) && await pg.locator('.toast.t-success:has-text("Request sent")').count() === 1);
  await pg.screenshot({path: OUT + '/n8-booking-phone.png', fullPage: true}); await pg.close();
  pg = await open(browser, '', P, '/app/', null, false); await pg.evaluate(() => { window.__termsFail = true; }); await pg.evaluate(() => go('xray')); await pg.evaluate(() => go('book')); await sleep(300);
  ok('booking: if the terms cannot load, the request is blocked and says why', (await pg.locator('#bterms .err').count()) === 1 && await pg.evaluate(async () => { document.querySelector('#bcons').checked = true; document.querySelector('#bgo').click(); await new Promise(r => setTimeout(r, 300)); return !window.__booked && document.querySelector('#berr').textContent.includes('could not be loaded'); }));
  await pg.close();

  /* ---------- merged AI X-ray (demo mode, patient then doctor, same browser store) ---------- */
  const shared = await browser.newContext({viewport: D, deviceScaleFactor: 1});
  pg = await open(browser, '', P, '/app/#xray', shared, true);
  ok('xray: opens inside the main app for a signed-out patient', await pg.locator('#xray:not([hidden])').count() === 1 && await pg.locator('#nav .tab:has-text("X-ray"), #nav .tab:has-text("AI X-ray")').count() >= 1);
  ok('xray: demo banner shows (no AI call is made)', await pg.locator('#x-demo:not([hidden])').count() === 1);
  ok('xray: body-part list is filled', await pg.locator('#x-part option').count() > 5);
  await pg.click('#x-go'); ok('xray: empty form shows an error', (await pg.locator('#x-ferr').textContent()) !== '');
  const png = await pg.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, 600, 600); g.fillStyle = '#bbb'; g.fillRect(200, 100, 200, 400); return c.toDataURL('image/png').split(',')[1]; });
  await pg.fill('#x-name', '<img src=x onerror=window.pwned=1>'); await pg.fill('#x-phone', '9800000000'); await pg.fill('#x-age', '34');
  await pg.selectOption('#x-sex', 'female'); await pg.selectOption('#x-part', 'chest'); await pg.selectOption('#x-side', 'na');
  await pg.setInputFiles('#x-file', {name: 'x.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')});
  await pg.click('#x-go'); ok('xray: consent is required', (await pg.locator('#x-ferr').textContent()).includes('consent'));
  await pg.check('#x-consent'); await pg.click('#x-go'); await pg.waitForSelector('#x-scan:not([hidden])'); await sleep(700);
  ok('xray: image is on the page only while scanning', await pg.evaluate(() => document.querySelector('#x-canvas').width > 0));
  await pg.waitForSelector('#x-done:not([hidden])', {timeout: 15000});
  ok('xray: image is wiped after the scan', await pg.evaluate(() => [document.querySelector('#x-canvas').width, document.querySelector('#x-file').files.length].join()) === '0,0');
  ok('xray: no image data in browser storage', await pg.evaluate(() => { const s = JSON.stringify([{...localStorage}, {...sessionStorage}]); return !s.includes('base64') && !s.includes('/9j/') && !s.includes('iVBOR'); }));
  const ref = await pg.textContent('#x-dref'), code = await pg.textContent('#x-dcode');
  ok('xray: patient gets a report number and one-time code', /^XR-/.test(ref) && /^\d{8}$/.test(code));
  await pg.click('#x-t-report'); await pg.fill('#x-lref', ref); await pg.fill('#x-lcode', code); await pg.click('#x-lform button[type=submit]'); await pg.waitForSelector('#x-result .card');
  ok('xray: before approval the patient sees "waiting", not findings', (await pg.textContent('#x-result')).includes('Waiting for doctor review') && !(await pg.textContent('#x-result')).includes('SAMPLE'));
  const dpg = await open(browser, 'doctor', D, '/app/', shared, true); await dpg.evaluate(() => go('xrv')); await sleep(500);
  ok('xray: doctor sees the review screen in the same app', await dpg.locator('#xrv:not([hidden])').count() === 1 && await dpg.locator('#x-note[hidden]').count() === 1);
  await dpg.waitForSelector('#x-queue .row'); await dpg.click('#x-queue .row'); await dpg.waitForSelector('#x-detail fieldset');
  await dpg.screenshot({path: OUT + '/n9-xray-review-desktop.png', fullPage: true});
  await dpg.click('text=Approve and release to patient'); ok('xray: release is blocked without the confirmation tick', (await dpg.locator('#x-detail .err[role=alert]').textContent()).includes('Tick the box'));
  await dpg.getByLabel('Impression').fill('Doctor-edited impression (test).'); await dpg.getByRole('checkbox').check(); await dpg.click('text=Approve and release to patient');
  await dpg.waitForSelector('#x-list:not([hidden]) >> text=Nothing here');
  await pg.click('#x-lform button[type=submit]'); await pg.waitForSelector('#x-result .sign');
  ok('xray: patient sees the doctor edit, the reviewer and the AI disclosure', (await pg.textContent('#x-result')).includes('Doctor-edited impression') && (await pg.textContent('#x-result')).includes('DEMO-000') && (await pg.textContent('#x-result')).includes('AI was used'));
  ok('xray: typed HTML never ran', await pg.evaluate(() => window.pwned) === undefined);
  ok('xray: no console errors (patient and doctor)', pg.errs.length === 0 && dpg.errs.length === 0, pg.errs.concat(dpg.errs).join(' | '));
  await pg.screenshot({path: OUT + '/n10-xray-patient-phone.png', fullPage: true});
  await dpg.close(); await pg.close(); await shared.close();
  const lp = await open(browser, 'lab', D, '/app/');
  ok('xray: lab staff do not get the review tab but do get the patient X-ray tab', await lp.locator('#nav .tab:has-text("X-ray review")').count() === 0 && await lp.locator('#nav .tab:has-text("AI X-ray")').count() === 1); await lp.close();

  /* ---------- roles + signed-out ---------- */
  await pg.close(); pg = await open(browser, '', D, '/app/');
  ok('signed out: no bell', await pg.locator('#bell').count() === 0);
  await pg.close(); pg = await open(browser, 'pharmacy', D, '/app/');
  ok('pharmacy staff get a bell', await pg.locator('#bell').count() === 1);
  await pg.evaluate(() => { __N.splice(0, __N.length); __fire(); }); await sleep(900);
  await pg.click('#bell'); await sleep(150);
  ok('no notifications: friendly empty state', await pg.locator('.nempty').count() === 1);
  await pg.evaluate(() => sb.auth.signOut && 0); await pg.close();
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
