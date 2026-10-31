document.addEventListener('DOMContentLoaded', () => {
  const checkinScreen = document.getElementById('checkin-screen');
  const passScreen = document.getElementById('pass-screen');
  const checkinForm = document.getElementById('checkin-form');

  const guestNameInput = document.getElementById('guest-name');
  const hostNameInput = document.getElementById('host-name');
  const guestPhoneInput = document.getElementById('guest-phone');
  const visitPurposeSelect = document.getElementById('visit-purpose');

  const passGuestName = document.getElementById('pass-guest-name');
  const passHostName = document.getElementById('pass-host-name');
  const passId = document.getElementById('pass-id');
  const passQrImg = document.getElementById('pass-qr-img');
  const btnResetCheckin = document.getElementById('btn-reset-checkin');

  const countActive = document.getElementById('count-active');
  const countTotal = document.getElementById('count-total');
  const ledgerList = document.getElementById('ledger-list');
  const hostSearch = document.getElementById('host-search');
  const hostResults = document.getElementById('host-results');

  const toastBanner = document.getElementById('toast-banner');
  const toastTitle = document.getElementById('toast-title');
  const toastBody = document.getElementById('toast-body');

  const OFFLINE_KEY = 'guestpass_offline_queue'; // offline fallback queue (not the ledger)

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return '-'; }
  };

  const getOfflineQueue = () => {
    try { return JSON.parse(localStorage.getItem(OFFLINE_KEY)) || []; }
    catch { return []; }
  };
  const setOfflineQueue = (q) => localStorage.setItem(OFFLINE_KEY, JSON.stringify(q));

  const showToast = (title, message) => {
    toastTitle.textContent = title;
    toastBody.textContent = message;
    toastBanner.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastBanner.classList.add('hidden'), 4000);
  };

  const renderLedger = (passes, offlineQueue) => {
    const activeCount = passes.filter((v) => v.status === 'Active').length;
    countActive.textContent = activeCount;
    countTotal.textContent = passes.length;

    let html = '';
    if (passes.length === 0) {
      html = `<tr class="empty-state"><td colspan="6">No visitors recorded yet. Use the check-in form.</td></tr>`;
    } else {
      html = passes.map((v) => {
        const safeId = escapeHtml(v.id);
        const out = v.checked_out_at ? fmtTime(v.checked_out_at) : '-';
        return `<tr class="${v.status === 'Checked Out' ? 'checked-out-row' : ''}">
          <td style="font-weight: 600;">${escapeHtml(v.name)}</td>
          <td>${escapeHtml(v.host)}</td>
          <td><span class="pill">${escapeHtml(v.purpose)}</span></td>
          <td>${escapeHtml(fmtTime(v.checked_in_at))}</td>
          <td><span class="status-badge ${v.status === 'Active' ? 'active' : 'checked-out'}">${escapeHtml(v.status)}</span></td>
          <td>${v.status === 'Active'
            ? `<button class="btn-checkout" data-checkout-id="${safeId}">Check Out</button>`
            : `<span style="font-size: 0.8rem; color: var(--muted);">${escapeHtml(out)}</span>`}
          </td>
        </tr>`;
      }).join('');
    }
    if (offlineQueue && offlineQueue.length) {
      html += `<tr class="empty-state"><td colspan="6">Offline fallback queue (${offlineQueue.length} queued, not yet sent — will retry when the backend is reachable).</td></tr>`;
    }
    ledgerList.innerHTML = html;
    ledgerList.querySelectorAll('[data-checkout-id]').forEach((btn) => {
      btn.addEventListener('click', () => checkoutVisitor(btn.getAttribute('data-checkout-id')));
    });
  };

  const loadLedger = async () => {
    try {
      const r = await fetch('/api/ledger', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`ledger HTTP ${r.status}`);
      const j = await r.json();
      renderLedger(Array.isArray(j.passes) ? j.passes : [], getOfflineQueue());
    } catch (e) {
      renderLedger([], getOfflineQueue());
      showToast('⚠️ Backend unreachable', 'Showing offline fallback queue. Check-ins will be queued locally.');
    }
  };

  const flushOfflineQueue = async () => {
    const q = getOfflineQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      try {
        const r = await fetch('/api/checkin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        });
        if (!r.ok) remaining.push(item);
      } catch { remaining.push(item); }
    }
    setOfflineQueue(remaining);
    if (q.length !== remaining.length) {
      showToast('🔄 Offline queue synced', `${q.length - remaining.length} queued check-in(s) sent.`);
      loadLedger();
    }
  };

  checkinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = guestNameInput.value.trim();
    const host = hostNameInput.value.trim();
    const phone = guestPhoneInput.value.trim();
    const purpose = visitPurposeSelect.value;

    try {
      const r = await fetch('/api/checkin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, host, phone, purpose }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        showToast('❌ Check-in rejected', j.error || `HTTP ${r.status}`);
        return;
      }
      const pass = j.pass;
      passGuestName.textContent = pass.name;
      passHostName.textContent = pass.host;
      passId.textContent = `ID: ${pass.id}`;
      if (passQrImg) {
        passQrImg.src = `/api/pass/${encodeURIComponent(pass.id)}/qr`;
        passQrImg.style.display = 'block';
      }
      checkinScreen.classList.add('hidden');
      passScreen.classList.remove('hidden');
      showToast('🔔 Guest Checked In!', `${pass.name} has checked in to meet ${pass.host}.`);
      checkinForm.reset();
      loadLedger();
    } catch (err) {
      // Offline fallback queue, clearly labeled — no QR without the backend.
      const q = getOfflineQueue();
      q.push({ name, host, phone, purpose, queued_at: new Date().toISOString() });
      setOfflineQueue(q);
      passGuestName.textContent = name;
      passHostName.textContent = host;
      passId.textContent = 'Queued offline — QR available once reconnected';
      if (passQrImg) passQrImg.style.display = 'none';
      checkinScreen.classList.add('hidden');
      passScreen.classList.remove('hidden');
      showToast('📥 Saved offline', 'Backend unreachable — check-in queued locally and labeled as offline.');
      loadLedger();
    }
  });

  btnResetCheckin.addEventListener('click', () => {
    passScreen.classList.add('hidden');
    checkinScreen.classList.remove('hidden');
  });

  async function checkoutVisitor(id) {
    try {
      const r = await fetch('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        showToast('❌ Check-out failed', j.error || `HTTP ${r.status}`);
        return;
      }
      showToast('🚪 Guest Checked Out', `${j.pass.name} has signed out.`);
      loadLedger();
    } catch {
      showToast('⚠️ Backend unreachable', 'Check-out needs the backend — please retry.');
    }
  }
  window.checkoutVisitor = checkoutVisitor; // kept for compat; buttons use data-attributes

  // Host search box → GET /api/hosts?q=
  let searchTimer = null;
  if (hostSearch) {
    hostSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = hostSearch.value.trim();
        try {
          const r = await fetch(`/api/hosts?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error();
          const j = await r.json();
          const hosts = Array.isArray(j.hosts) ? j.hosts : [];
          hostResults.innerHTML = hosts.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
        } catch { hostResults.innerHTML = ''; }
      }, 200);
    });
  }

  loadLedger();
  flushOfflineQueue();
});
