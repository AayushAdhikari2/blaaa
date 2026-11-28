/* ===== step 3 (screen part): print-ready visit slip with QR =====
   Loads after app-queue.js, before app-start.js. Needs schema_v13_token.sql for the token fix (separate, database side).
   After registering, a slip window opens with one big "Print slip" button and the QR code (instead of the small inline box).
   Every "Slip" button in the lists opens the same window. */

const _printSlip = window.printSlip;        // the original: prints the 80 mm slip through the hidden print area

document.head.append(h('style', null, `
#slip{display:none!important}
dialog.slipdlg{width:min(380px,calc(100vw - 28px))}
.slipdlg .in{text-align:center}
.slipdlg .tkn{font-size:64px;font-weight:700;line-height:1;margin:8px 0;color:var(--g)}
.slipdlg .rowc{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:4px 0}
.slipdlg hr{border:0;border-top:1px dashed var(--line);margin:10px 0}
.slipdlg .qr{width:170px;height:170px;image-rendering:pixelated;margin:6px auto;display:block}
.slipdlg .btn{min-height:48px;font-size:16px;width:100%;margin-top:8px}
@media print{dialog.slipdlg,dialog.slipdlg::backdrop{display:none!important}}
`));

function slipDialog(v) {
  document.querySelectorAll('dialog.slipdlg').forEach(d => d.remove());
  const d = doc(v.doctor_id);
  const print = h('button', {class: 'btn', onclick: () => _printSlip(v)}, 'Print slip');
  const close = h('button', {class: 'btn ghost', onclick: () => dlg.close()}, 'Done');
  const dlg = UI.modal('Visit slip', h('div', {class: 'in'},
    h('div', {class: 'muted'}, clinicName() + ' · Visit slip'),
    h('div', {class: 'tkn', 'aria-label': 'Token ' + v.token}, tk(v.token)),
    h('div', null, h('b', null, v.name)),
    h('div', {class: 'muted'}, d.name + (d.dept ? ' · ' + d.dept : '')),
    h('hr'),
    h('div', {class: 'rowc'}, h('span', null, 'Bill no'), h('b', null, v.bill)),
    h('div', {class: 'rowc'}, h('span', null, 'Access code'), h('b', null, v.code)),
    qrImg(statusLink(v.bill, v.code), 5),
    h('div', {class: 'muted', style: 'font-size:12px'}, 'Scan to see the waiting number, report and bill. Keep the slip private: the code opens the status.'),
    print, close), {cls: 'slipdlg'});
  print.focus();
}
window.printSlip = slipDialog;              // the "Slip" buttons in the lists call printSlip(v)

// after a successful registration, open the slip window (app.js and app-patients.js stay untouched)
const _rpcSlip = sb.rpc.bind(sb);
sb.rpc = (fn, args, opts) => {
  if (fn !== 'register_visit') return _rpcSlip(fn, args, opts);
  return (async () => {
    const r = await _rpcSlip(fn, args, opts);
    if (!r.error && r.data) setTimeout(() => slipDialog(r.data), 0);
    return r;
  })();
};
