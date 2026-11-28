/* UI audit: opens every screen for every role at phone / tablet / desktop widths and reports
   horizontal overflow, small touch targets, and accessibility violations (axe-core).
   Run: AXE=/path/to/axe.min.js node audit.js   (axe-core: npm i axe-core).  Screenshots go to ./shots/audit */
const {chromium} = require('playwright'), fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), OUT = path.join(process.env.SHOTS || path.join(__dirname, 'shots'), 'audit');
const AXE = fs.readFileSync(process.env.AXE || require.resolve('axe-core/axe.min.js'), 'utf8');
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};
const srv = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, {'Content-Type': mime[path.extname(f)] || 'application/octet-stream'}); r.end(d); }); });
const STUB = fs.readFileSync(path.join(__dirname, 'stub-browser.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'stub-notify.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VPS = {phone: {width: 390, height: 780}, tablet: {width: 820, height: 1100}, desktop: {width: 1280, height: 800}};
const ROLES = {'': ['pat', 'book', 'xray', 'board', 'staff'], admin: null, reception: null, doctor: null, lab: null, pharmacy: null};
const findings = {};
const add = (k, v) => (findings[k] = findings[k] || new Set()).add(v);
(async () => {
  fs.mkdirSync(OUT, {recursive: true}); await new Promise(r => srv.listen(8124, r));
  const browser = await chromium.launch();
  for (const [vpn, vp] of Object.entries(VPS)) for (const role of Object.keys(ROLES)) {
    const ctx = await browser.newContext({viewport: vp, hasTouch: vpn === 'phone', isMobile: vpn === 'phone'}); const pg = await ctx.newPage();
    pg.on('pageerror', e => add('JS error', `${role || 'public'}/${vpn}: ${e.message}`));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) add('console error', `${role || 'public'}/${vpn}: ${m.text().slice(0, 120)}`); });
    await pg.route('**/*', rt => { const u = rt.request().url();
      if (u.includes('supabase-js')) return rt.fulfill({contentType: 'text/javascript', body: STUB});
      if (u.includes('qrcode-generator')) return rt.fulfill({contentType: 'text/javascript', body: fs.readFileSync(require.resolve('qrcode-generator/qrcode.js'), 'utf8')});
      if (u.includes('fonts.g')) return rt.abort(); return rt.continue(); });
    await pg.addInitScript(r => { window.__ROLE = r; }, role);
    await pg.goto('http://localhost:8124/app/', {waitUntil: 'load'}); await sleep(700);
    const views = await pg.evaluate(() => tabs().map(t => t[0]));
    for (const v of views) {
      const label = `${role || 'public'}/${vpn}/${v}`;
      await pg.evaluate(x => { if (x === 'adm') { go('adm'); } else go(x); }, v); await sleep(450);
      if (v === 'adm') for (const sub of ['Team', 'Reports', 'Settings']) { const b = pg.locator('#admtabs button', {hasText: sub}); if (await b.count()) { await b.first().click(); await sleep(350); } }
      const m = await pg.evaluate(() => {
        const out = {over: document.documentElement.scrollWidth - innerWidth, small: [], clipped: []};
        const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        if (matchMedia('(max-width: 899px)').matches) document.querySelectorAll('main button, main .btn, main select, main input:not([type=checkbox]):not([type=radio]):not([type=file]), .tab, .bell').forEach(e => {
          if (!vis(e) || e.closest('[hidden]')) return; const r = e.getBoundingClientRect(); if (r.height < 36 && !e.closest('.bar,.bars')) out.small.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + (e.className || '').toString().split(' ')[0]) + ' ' + Math.round(r.height) + 'px "' + (e.textContent || e.value || '').trim().slice(0, 18) + '"'); });
        document.querySelectorAll('main *').forEach(e => { if (!vis(e) || e.closest('[hidden]')) return; const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 && !e.closest('.bars,.steps,.subtabs,table,pre')) out.clipped.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '.' + (e.className || '').toString().split(' ')[0])); });
        return out;
      });
      if (m.over > 1) add('horizontal overflow', `${label} (+${m.over}px)`);
      [...new Set(m.small)].slice(0, 4).forEach(s => add('touch target < 36px', `${label}: ${s}`));
      [...new Set(m.clipped)].slice(0, 3).forEach(s => add('content past right edge', `${label}: ${s}`));
      await pg.evaluate(AXE);
      const res = await pg.evaluate(async () => (await axe.run(document, {runOnly: ['wcag2a', 'wcag2aa', 'best-practice'], rules: {'region': {enabled: false}, 'landmark-one-main': {enabled: false}, 'page-has-heading-one': {enabled: false}}})).violations.map(v => ({id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map(n => n.target.join(' ').slice(0, 70)), help: v.help})));
      res.forEach(v => add(`a11y [${v.impact}] ${v.id}: ${v.help}`, `${label} x${v.n} e.g. ${v.ex[0]}`));
      if (vpn !== 'tablet' && (role === 'admin' || role === '' )) await pg.screenshot({path: `${OUT}/${role || 'public'}-${vpn}-${v}.png`});
    }
    await ctx.close();
  }
  await browser.close(); srv.close();
  const keys = Object.keys(findings).sort();
  if (!keys.length) console.log('No findings.');
  for (const k of keys) { const a = [...findings[k]]; console.log(`\n## ${k}  (${a.length} places)`); a.slice(0, 6).forEach(x => console.log('  - ' + x)); if (a.length > 6) console.log('  … +' + (a.length - 6) + ' more'); }
})().catch(e => { console.error('CRASH', e); process.exit(2); });
