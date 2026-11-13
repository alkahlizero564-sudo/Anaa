// ===================== أدوات عامة =====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body, token = store.get('sessionToken') } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `خطأ ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
function ago(ts) {
  if (!ts) return 'لم يتصل بعد';
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'الآن';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const fullTime = (ts) => (ts ? new Date(ts).toLocaleString('ar') : '—');
const ONLINE_WINDOW = 3 * 60 * 1000;
const isOnline = (d) => d.lastSeen && Date.now() - d.lastSeen < ONLINE_WINDOW;

function batteryHtml(status) {
  if (!status || status.battery == null) return '<span class="battery">🔋 غير معروفة</span>';
  const pct = Math.round(status.battery * 100);
  const cls = pct <= 15 ? 'low' : pct <= 40 ? 'mid' : '';
  return `<span class="battery" title="البطارية">
    <span class="battery-bar"><span class="battery-fill ${cls}" style="width:${pct}%;display:block"></span></span>
    ${pct}%${status.charging ? ' ⚡' : ''}</span>`;
}

const NETWORK_LABEL = { wifi: 'واي فاي', cellular: 'بيانات الجوال', ethernet: 'سلكي', '4g': '4G', '3g': '3G', '2g': '2G', 'slow-2g': '2G بطيء', offline: 'غير متصل' };
function platformLabel(ua) {
  if (!ua) return '—';
  const android = ua.match(/Android [\d.]+(?:; ([^;)]+))?/);
  if (android) return `أندرويد${android[1] ? ' — ' + android[1].trim() : ''}`;
  if (/iPhone|iPad/.test(ua)) return 'آيفون / آيباد';
  if (/Windows/.test(ua)) return 'ويندوز';
  if (/Mac OS/.test(ua)) return 'ماك';
  if (/Linux/.test(ua)) return 'لينكس';
  return 'غير معروف';
}
const netLabel = (n) => NETWORK_LABEL[n] || n || 'غير معروفة';

// ===================== الجلسة =====================
let currentUser = null;

async function boot() {
  registerServiceWorker();
  setupGoogleSignIn();
  const token = store.get('sessionToken');
  if (token) {
    try {
      const { user } = await api('/api/me');
      return enterApp(user);
    } catch (e) {
      if (e.status === 401) store.del('sessionToken');
    }
  }
  // جهاز مفعّل يستمر في الإرسال حتى لو انتهت جلسة المستخدم
  if (store.get('deviceToken')) {
    showView('main');
    switchTab('this-device');
    startTracking();
    return;
  }
  showView('auth');
}

function showView(name) {
  $('#auth-view').hidden = name !== 'auth';
  $('#main-view').hidden = name !== 'main';
}

// ---- نموذج الدخول ----
let authMode = 'login';
$$('[data-auth-tab]').forEach((btn) => btn.addEventListener('click', () => {
  authMode = btn.dataset.authTab;
  $$('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  $('#auth-submit').textContent = authMode === 'login' ? 'دخول' : 'إنشاء حساب';
  $('#auth-form [name=password]').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = $('#auth-submit');
  $('#auth-error').textContent = '';
  btn.disabled = true;
  try {
    const { token, user } = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: { email: f.email.value, password: f.password.value },
      token: null,
    });
    store.set('sessionToken', token);
    f.reset();
    enterApp(user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- تسجيل الدخول عبر جوجل (يظهر فقط إذا ضُبط GOOGLE_CLIENT_ID على الخادم) ----
async function setupGoogleSignIn() {
  let googleClientId;
  try { ({ googleClientId } = await api('/api/config', { token: null })); } catch { return; }
  if (!googleClientId) return;
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.onload = () => {
    google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async ({ credential }) => {
        $('#auth-error').textContent = '';
        try {
          const { token, user } = await api('/api/auth/google', { method: 'POST', body: { credential }, token: null });
          store.set('sessionToken', token);
          enterApp(user);
        } catch (err) {
          $('#auth-error').textContent = err.message;
        }
      },
    });
    google.accounts.id.renderButton($('#google-signin'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ar', width: 320 });
    $('#google-signin-wrap').hidden = false;
  };
  document.head.append(script);
}

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  store.del('sessionToken');
  currentUser = null;
  stopDashboard();
  if (store.get('deviceToken')) {
    toast('تم تسجيل الخروج. هذا الجهاز ما زال يشارك موقعه.');
    $('#user-email').textContent = '';
    switchTab('this-device');
  } else {
    showView('auth');
  }
});

function enterApp(user) {
  currentUser = user;
  $('#user-email').textContent = user.email;
  showView('main');
  switchTab(store.get('deviceToken') && !store.get('lastTab') ? 'this-device' : (store.get('lastTab') || 'dashboard'));
  if (store.get('deviceToken')) startTracking();
}

// ---- التبويبات ----
$$('[data-tab]').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function switchTab(tab) {
  if (tab === 'dashboard' && !currentUser) { showView('auth'); return; }
  store.set('lastTab', tab);
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#dashboard').hidden = tab !== 'dashboard';
  $('#this-device').hidden = tab !== 'this-device';
  if (tab === 'dashboard') startDashboard(); else stopDashboard();
  if (tab === 'this-device') renderThisDevice();
}

// ===================== لوحة الأجهزة =====================
let map, markers = new Map(), accuracyCircles = new Map(), historyLine = null;
let devices = [];
let selectedId = null;
let pollTimer = null;
let fittedOnce = false;

function ensureMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  map = L.map('map', { zoomControl: true }).setView([26.8, 30.8], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
}

function startDashboard() {
  ensureMap();
  loadDevices();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadDevices, 15000);
}
function stopDashboard() { clearInterval(pollTimer); pollTimer = null; }

$('#refresh-btn').addEventListener('click', () => loadDevices(true));

async function loadDevices(manual = false) {
  try {
    ({ devices } = await api('/api/devices'));
    renderDevices();
    if (manual) toast('تم التحديث');
  } catch (e) {
    if (e.status === 401) { store.del('sessionToken'); showView('auth'); }
    else toast(e.message);
  }
}

function deviceIcon(d) {
  const color = d.lostMode ? '#dc2626' : isOnline(d) ? '#16a34a' : '#64748b';
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;border-radius:50%;width:34px;height:34px;display:grid;place-items:center;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);font-size:16px">📱</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function renderDevices() {
  const list = $('#device-list');
  list.innerHTML = '';
  $('#empty-devices').hidden = devices.length > 0;

  const seen = new Set();
  for (const d of devices) {
    seen.add(d.id);
    const li = document.createElement('li');
    li.className = 'device' + (d.id === selectedId ? ' selected' : '');
    li.innerHTML = `
      <div class="device-top">
        <span class="device-name">${esc(d.name)}</span>
        ${d.lostMode ? '<span class="badge">مفقود</span>' : ''}
      </div>
      <div class="device-meta">
        <span><span class="dot ${isOnline(d) ? 'on' : ''}"></span>${isOnline(d) ? 'متصل' : 'آخر ظهور ' + esc(ago(d.lastSeen))}</span>
        ${batteryHtml(d.status)}
      </div>`;
    li.addEventListener('click', () => selectDevice(d.id));
    list.append(li);

    // علامة الخريطة
    if (d.location) {
      const ll = [d.location.lat, d.location.lng];
      let m = markers.get(d.id);
      if (!m) {
        m = L.marker(ll, { icon: deviceIcon(d) }).addTo(map).on('click', () => selectDevice(d.id));
        markers.set(d.id, m);
        const c = L.circle(ll, { radius: d.location.accuracy || 0, weight: 1, fillOpacity: .12 }).addTo(map);
        accuracyCircles.set(d.id, c);
      } else {
        m.setLatLng(ll).setIcon(deviceIcon(d));
        accuracyCircles.get(d.id).setLatLng(ll).setRadius(d.location.accuracy || 0);
      }
      m.bindTooltip(esc(d.name), { direction: 'top', offset: [0, -16] });
    }
  }
  // إزالة علامات الأجهزة المحذوفة
  for (const [id, m] of markers) {
    if (!seen.has(id)) { m.remove(); markers.delete(id); accuracyCircles.get(id)?.remove(); accuracyCircles.delete(id); }
  }

  if (!fittedOnce && markers.size) {
    fittedOnce = true;
    const group = L.featureGroup([...markers.values()]);
    map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 16 });
  }
  if (selectedId && !seen.has(selectedId)) selectedId = null;
  renderDetail();
}

function selectDevice(id) {
  selectedId = id;
  const d = devices.find((x) => x.id === id);
  if (d?.location) map.setView([d.location.lat, d.location.lng], Math.max(map.getZoom(), 16));
  clearHistory();
  renderDevices();
}

function clearHistory() {
  if (historyLine) { historyLine.remove(); historyLine = null; }
}

function renderDetail() {
  const box = $('#device-detail');
  const d = devices.find((x) => x.id === selectedId);
  if (!d) { box.hidden = true; return; }
  box.hidden = false;
  const loc = d.location;
  const s = d.status;
  box.innerHTML = `
    <h3>${esc(d.name)}</h3>
    <dl class="stats">
      <div><dt>الحالة</dt><dd>${isOnline(d) ? '🟢 متصل' : '⚪ غير متصل'}</dd></div>
      <div><dt>آخر ظهور</dt><dd title="${esc(fullTime(d.lastSeen))}">${esc(ago(d.lastSeen))}</dd></div>
      <div><dt>البطارية</dt><dd>${batteryHtml(s)}</dd></div>
      <div><dt>الشبكة</dt><dd>${esc(s ? netLabel(s.online === false ? 'offline' : s.network) : '—')}</dd></div>
      <div><dt>آخر موقع</dt><dd title="${esc(fullTime(loc?.at))}">${loc ? esc(ago(loc.at)) : 'غير متاح'}</dd></div>
      <div><dt>دقة الموقع</dt><dd>${loc?.accuracy != null ? `± ${Math.round(loc.accuracy)} م` : '—'}</dd></div>
      <div><dt>الشاشة</dt><dd>${s?.screen === 'visible' ? 'التطبيق ظاهر' : s?.screen === 'hidden' ? 'في الخلفية' : '—'}</dd></div>
      <div><dt>النظام</dt><dd title="${esc(d.platform || '')}">${esc(platformLabel(d.platform))}</dd></div>
    </dl>
    <div class="actions">
      <button class="btn primary" data-act="ring">🔔 تشغيل رنين</button>
      <button class="btn" data-act="locate">📍 طلب موقع الآن</button>
      ${d.lostMode
        ? '<button class="btn" data-act="lost_off">إلغاء وضع الفقدان</button>'
        : '<button class="btn danger" data-act="lost_on">🚨 وضع الفقدان</button>'}
      <button class="btn" data-act="history">🕘 مسار آخر 24 ساعة</button>
      ${loc ? `<a class="btn wide" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}">🧭 الاتجاهات إلى الجهاز</a>` : ''}
      <button class="btn ghost small" data-act="rename">تعديل الاسم</button>
      <button class="btn ghost small danger" data-act="delete">حذف الجهاز</button>
    </div>
    ${d.lostMode && d.lostMessage ? `<p class="hint">رسالة وضع الفقدان: ${esc(JSON.parse(d.lostMessage).message)}</p>` : ''}
    <p class="hint">الأوامر تصل للجهاز عند اتصاله القادم (كل ~15 ثانية والتطبيق مفتوح).</p>`;

  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => deviceAction(d, b.dataset.act)));
}

async function deviceAction(d, act) {
  try {
    if (act === 'ring') {
      await api(`/api/devices/${d.id}/commands`, { method: 'POST', body: { type: 'ring' } });
      toast('تم إرسال أمر الرنين');
    } else if (act === 'locate') {
      await api(`/api/devices/${d.id}/commands`, { method: 'POST', body: { type: 'locate' } });
      toast('تم طلب الموقع، سيتحدث خلال لحظات');
      setTimeout(loadDevices, 8000);
    } else if (act === 'lost_on') {
      const message = prompt('الرسالة التي ستظهر على شاشة الجهاز:', 'هذا الهاتف مفقود. من فضلك تواصل معي لإعادته، وشكرًا لك.');
      if (message === null) return;
      const contact = prompt('رقم هاتف للتواصل (اختياري):', '') ?? '';
      await api(`/api/devices/${d.id}/commands`, { method: 'POST', body: { type: 'lost_mode_on', message, contact } });
      toast('تم تفعيل وضع الفقدان');
      loadDevices();
    } else if (act === 'lost_off') {
      await api(`/api/devices/${d.id}/commands`, { method: 'POST', body: { type: 'lost_mode_off' } });
      toast('تم إلغاء وضع الفقدان');
      loadDevices();
    } else if (act === 'history') {
      const { points } = await api(`/api/devices/${d.id}/history?hours=24`);
      clearHistory();
      if (points.length < 2) { toast('لا يوجد مسار كافٍ بعد'); return; }
      historyLine = L.polyline(points.map((p) => [p.lat, p.lng]), { color: '#0f766e', weight: 4, opacity: .8, dashArray: '6 6' }).addTo(map);
      map.fitBounds(historyLine.getBounds().pad(0.2));
      toast(`${points.length} نقطة في آخر 24 ساعة`);
    } else if (act === 'rename') {
      const name = prompt('الاسم الجديد:', d.name);
      if (!name) return;
      await api(`/api/devices/${d.id}`, { method: 'PATCH', body: { name } });
      loadDevices();
    } else if (act === 'delete') {
      if (!confirm(`حذف «${d.name}» وكل سجل مواقعه؟`)) return;
      await api(`/api/devices/${d.id}`, { method: 'DELETE' });
      selectedId = null;
      clearHistory();
      loadDevices();
    }
  } catch (e) {
    toast(e.message);
  }
}

// ===================== هذا الجهاز (التتبع) =====================
let tracking = false;
let lastPosition = null;
let watchId = null;
let reportTimer = null;
let commandTimer = null;
let battery = null;
let wakeLock = null;
let audioCtx = null;

function renderThisDevice() {
  const active = !!store.get('deviceToken');
  $('#enroll').hidden = active;
  $('#tracking').hidden = !active;
  if (active) $('#tracking-name').textContent = store.get('deviceName') || 'هذا الجهاز';
  if (!active && !currentUser) showView('auth');
}

$('#enroll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  $('#enroll-error').textContent = '';
  if (!f.consent.checked) { $('#enroll-error').textContent = 'يجب الموافقة أولًا'; return; }
  if (!('geolocation' in navigator)) { $('#enroll-error').textContent = 'هذا المتصفح لا يدعم تحديد الموقع'; return; }

  // نطلب إذن الموقع قبل التسجيل
  try {
    lastPosition = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000 }));
  } catch (err) {
    $('#enroll-error').textContent = err.code === 1 ? 'تم رفض إذن الموقع. فعّله من إعدادات المتصفح ثم حاول مجددًا.' : 'تعذّر تحديد الموقع، تأكد من تشغيل GPS';
    return;
  }

  try {
    const { device, deviceToken } = await api('/api/devices', {
      method: 'POST',
      body: { name: f.name.value, consent: true, platform: navigator.userAgent },
    });
    store.set('deviceToken', deviceToken);
    store.set('deviceName', device.name);
    unlockAudio();
    startTracking();
    renderThisDevice();
    toast('تم التفعيل! يمكنك الآن رؤية هذا الجهاز من «أجهزتي».');
  } catch (err) {
    $('#enroll-error').textContent = err.message;
  }
});

async function startTracking() {
  if (tracking) return;
  tracking = true;
  renderThisDevice();

  if ('getBattery' in navigator) {
    try {
      battery = await navigator.getBattery();
      battery.addEventListener('levelchange', updateTrackingUi);
      battery.addEventListener('chargingchange', () => sendReport());
    } catch { battery = null; }
  }

  watchId = navigator.geolocation?.watchPosition(
    (pos) => {
      const first = !lastPosition;
      lastPosition = pos;
      updateTrackingUi();
      if (first) sendReport(); // أرسل أول موقع فورًا بدل انتظار الدورة التالية
    },
    () => { /* نكمل بإرسال البطارية والحالة حتى بدون موقع */ },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 },
  );

  sendReport();
  reportTimer = setInterval(sendReport, 60000);
  commandTimer = setInterval(checkCommands, 15000);
  window.addEventListener('online', () => sendReport());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { sendReport(); if ($('#wake-toggle').checked) requestWakeLock(); }
  });
  // أول نقرة في الصفحة تسمح بتشغيل الصوت لاحقًا
  document.addEventListener('pointerdown', unlockAudio, { once: true });
}

function stopTracking() {
  tracking = false;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(reportTimer);
  clearInterval(commandTimer);
  releaseWakeLock();
}

function collectStatus() {
  const conn = navigator.connection || {};
  const network = !navigator.onLine ? 'offline' : (conn.type && conn.type !== 'unknown' ? conn.type : conn.effectiveType) || null;
  const body = {
    battery: battery ? battery.level : null,
    charging: battery ? battery.charging : null,
    online: navigator.onLine,
    network,
    screen: document.visibilityState,
  };
  if (lastPosition) {
    body.lat = lastPosition.coords.latitude;
    body.lng = lastPosition.coords.longitude;
    body.accuracy = lastPosition.coords.accuracy;
  }
  return body;
}

async function sendReport() {
  const token = store.get('deviceToken');
  if (!token) return;
  try {
    const { commands, name } = await api('/api/device/report', { method: 'POST', body: collectStatus(), token });
    store.set('lastReport', String(Date.now()));
    if (name) { store.set('deviceName', name); $('#tracking-name').textContent = name; }
    updateTrackingUi();
    handleCommands(commands);
  } catch (e) {
    if (e.status === 401) deviceRevoked();
  }
}

async function checkCommands() {
  const token = store.get('deviceToken');
  if (!token) return;
  try {
    const { commands } = await api('/api/device/commands', { token });
    handleCommands(commands);
  } catch (e) {
    if (e.status === 401) deviceRevoked();
  }
}

function deviceRevoked() {
  stopTracking();
  store.del('deviceToken');
  store.del('deviceName');
  $('#lost-overlay').hidden = true;
  stopRing();
  renderThisDevice();
  toast('تم إيقاف مشاركة هذا الجهاز');
}

async function handleCommands(commands = []) {
  const token = store.get('deviceToken');
  for (const c of commands) {
    if (c.type === 'ring') startRing();
    else if (c.type === 'locate') refreshPositionAndReport();
    else if (c.type === 'lost_mode_on') showLostMode(c.payload);
    else if (c.type === 'lost_mode_off') { $('#lost-overlay').hidden = true; store.del('lostMode'); }
    try { await api(`/api/device/commands/${c.id}/ack`, { method: 'POST', token }); } catch { /* retry next time */ }
  }
}

function refreshPositionAndReport() {
  navigator.geolocation?.getCurrentPosition(
    (pos) => { lastPosition = pos; sendReport(); },
    () => sendReport(),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

function updateTrackingUi() {
  const last = Number(store.get('lastReport')) || null;
  $('#t-last').textContent = last ? ago(last) : '—';
  $('#t-loc').textContent = lastPosition
    ? `${lastPosition.coords.latitude.toFixed(5)}, ${lastPosition.coords.longitude.toFixed(5)} (±${Math.round(lastPosition.coords.accuracy)} m)`
    : 'في انتظار GPS…';
  $('#t-batt').innerHTML = battery ? batteryHtml({ battery: battery.level, charging: battery.charging }) : 'غير مدعومة في هذا المتصفح';
  $('#t-net').textContent = netLabel(collectStatus().network);
}
setInterval(() => { if (tracking) updateTrackingUi(); }, 20000);

$('#send-now').addEventListener('click', () => { refreshPositionAndReport(); toast('جارٍ الإرسال…'); });

$('#stop-sharing').addEventListener('click', async () => {
  if (!confirm('إيقاف مشاركة موقع هذا الجهاز وحذفه من حسابك؟')) return;
  try { await api('/api/device', { method: 'DELETE', token: store.get('deviceToken') }); } catch { /* ignore */ }
  deviceRevoked();
});

// ---- إبقاء الشاشة مضاءة ----
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { wakeLock = null; }
}
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }
$('#wake-toggle').addEventListener('change', (e) => {
  store.set('wakeLock', e.target.checked ? '1' : '');
  if (e.target.checked) requestWakeLock(); else releaseWakeLock();
});
$('#wake-toggle').checked = !!store.get('wakeLock');
if ($('#wake-toggle').checked) requestWakeLock();

// ---- الرنين ----
let ringNodes = null;
let ringTimeout = null;

function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* ignore */ }
}

function startRing() {
  $('#ring-overlay').hidden = false;
  navigator.vibrate?.([800, 300, 800, 300, 800, 300, 800]);
  unlockAudio();
  if (!audioCtx || ringNodes) return;
  const osc = audioCtx.createOscillator();
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = 880;
  lfo.frequency.value = 3;
  lfoGain.gain.value = 300;
  lfo.connect(lfoGain).connect(osc.frequency);
  gain.gain.value = 0.6;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); lfo.start();
  ringNodes = { osc, lfo };
  clearTimeout(ringTimeout);
  ringTimeout = setTimeout(stopRing, 60000);
}

function stopRing() {
  $('#ring-overlay').hidden = true;
  navigator.vibrate?.(0);
  if (ringNodes) { try { ringNodes.osc.stop(); ringNodes.lfo.stop(); } catch { /* ignore */ } ringNodes = null; }
  clearTimeout(ringTimeout);
}
$('#stop-ring').addEventListener('click', stopRing);

// ---- وضع الفقدان ----
function showLostMode(payload = {}) {
  store.set('lostMode', JSON.stringify(payload));
  $('#lost-message').textContent = payload.message || 'هذا الهاتف مفقود.';
  const a = $('#lost-contact');
  if (payload.contact) {
    a.hidden = false;
    a.textContent = `📞 اتصل بالمالك: ${payload.contact}`;
    a.href = `tel:${payload.contact.replace(/[^\d+]/g, '')}`;
  } else {
    a.hidden = true;
  }
  $('#lost-overlay').hidden = false;
}
if (store.get('deviceToken') && store.get('lostMode')) {
  try { showLostMode(JSON.parse(store.get('lostMode'))); } catch { /* ignore */ }
}

// ===================== PWA =====================
function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
