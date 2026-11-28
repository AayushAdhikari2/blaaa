/* Adds fake notification functions to stub-browser.js (load it AFTER stub-browser.js). For headless-browser tests only. */
(function () {
  const orig = window.supabase.createClient, iso = m => new Date(Date.now() - m * 60000).toISOString();
  window.supabase.createClient = function () {
    const sb = orig.apply(this, arguments), rpc0 = sb.rpc;
    const N = window.__N = [
      {id: 1, kind: 'lab.request', severity: 'warning', title: 'New lab request', body: 'T-02 · Dr. Sharma is waiting for a report', view: 'lab', created_at: iso(3), persistent: true, read: false},
      {id: 2, kind: 'pharmacy.rx', severity: 'warning', title: 'New prescription to dispense', body: 'T-01 · Dr. Sharma', view: 'pha', created_at: iso(8), persistent: true, read: false},
      {id: 3, kind: 'pharmacy.low_stock', severity: 'critical', title: 'Low stock: Amoxicillin 500 mg', body: '0 in date (alert level 20)', view: 'pha', created_at: iso(30), persistent: true, read: false},
      {id: 4, kind: 'billing.paid', severity: 'success', title: 'Payment recorded', body: 'T-03 marked as paid', view: 'rec', created_at: iso(60), persistent: false, read: false},
      {id: 5, kind: 'queue.new', severity: 'info', title: 'New patient in your queue', body: 'T-04 registered for Dr. Sharma', view: 'doc', created_at: iso(300), persistent: false, read: true},
      {id: 6, kind: 'admin.staff', severity: 'info', title: 'Staff account created', body: 'Anita Admin · admin', view: 'adm', created_at: iso(1500), persistent: false, read: true}];
    window.__calls = [];
    const split = () => ({pending: N.filter(x => x.persistent && !x.resolved), recent: N.filter(x => !(x.persistent && !x.resolved)).sort((a, b) => b.id - a.id)});
    sb.rpc = (n, a) => {
      window.__calls.push(n);
      if (n === 'notif_list') { const s = split(); return Promise.resolve({data: {unread: N.filter(x => !x.read).length, pending: s.pending, recent: s.recent}, error: null}); }
      if (n === 'notif_unread_count') return Promise.resolve({data: N.filter(x => !x.read).length, error: null});
      if (n === 'notif_mark') { N.filter(x => a.p_ids.includes(x.id)).forEach(x => x.read = a.p_read); return Promise.resolve({data: a.p_ids.length, error: null}); }
      if (n === 'notif_mark_all_read') { N.forEach(x => x.read = true); return Promise.resolve({data: N.length, error: null}); }
      if (n === 'public_terms') return Promise.resolve(window.__termsFail ? {data: null, error: {message: 'offline'}} : {data: {text: 'Booking is a request. It is confirmed by reception.\n\nThis service is not for emergencies.', clinic: 'RADIX AI Clinic'}, error: null});
      if (n === 'request_appointment') { window.__booked = a; return Promise.resolve({data: null, error: null}); }
      if (n === 'notif_maintenance' || n === 'notif_report_error') return Promise.resolve({data: null, error: null});
      return rpc0(n, a);
    };
    const handlers = []; sb.channel = () => ({on(_, __, cb) { handlers.push(cb); return this; }, subscribe(cb) { cb && cb('SUBSCRIBED'); return this; }});
    sb.removeChannel = () => {}; window.__fire = () => handlers.forEach(h => h({}));
    return sb;
  };
})();
