import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_DEVICE = 1000;
const COMMAND_TYPES = new Set(['ring', 'lost_mode_on', 'lost_mode_off', 'locate']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- helpers ----------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'الطلب كبير جدًا');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON غير صالح');
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

const num = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
};
const bool = (v) => (v === true ? 1 : v === false ? 0 : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// Very small in-memory rate limiter for auth endpoints.
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

// ---------- app ----------
// Verifies a Google ID token (from "Sign in with Google") using Google's tokeninfo endpoint.
async function verifyGoogleIdToken(credential, clientId) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) return null;
  const info = await res.json();
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (!issOk || info.aud !== clientId || Number(info.exp) * 1000 < Date.now()) return null;
  return { email: info.email, emailVerified: info.email_verified === true || info.email_verified === 'true' };
}

export function createApp({ db, publicDir, googleClientId = null, verifyGoogle = verifyGoogleIdToken }) {
  const authLimit = rateLimiter(20, 15 * 60 * 1000);

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    insertDevice: db.prepare(`INSERT INTO devices (user_id, name, platform, token_hash, created_at)
                              VALUES (?, ?, ?, ?, ?)`),
    devicesForUser: db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY id'),
    deviceForUser: db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?'),
    deviceByToken: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
    deleteDevice: db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?'),
    renameDevice: db.prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ?'),
    touchDevice: db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?'),
    setLostMode: db.prepare('UPDATE devices SET lost_mode = ?, lost_message = ? WHERE id = ?'),
    latestReport: db.prepare('SELECT * FROM reports WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'),
    lastLocated: db.prepare(`SELECT * FROM reports WHERE device_id = ? AND lat IS NOT NULL
                             ORDER BY created_at DESC, id DESC LIMIT 1`),
    history: db.prepare(`SELECT created_at, lat, lng, accuracy, battery, charging FROM reports
                         WHERE device_id = ? AND lat IS NOT NULL AND created_at >= ?
                         ORDER BY created_at DESC LIMIT ?`),
    insertReport: db.prepare(`INSERT INTO reports (device_id, created_at, lat, lng, accuracy, battery, charging, network, online, screen)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    pruneReports: db.prepare(`DELETE FROM reports WHERE device_id = ? AND id NOT IN
                              (SELECT id FROM reports WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`),
    insertCommand: db.prepare('INSERT INTO commands (device_id, type, payload, created_at) VALUES (?, ?, ?, ?)'),
    pendingCommands: db.prepare('SELECT id, type, payload, created_at FROM commands WHERE device_id = ? AND acked_at IS NULL ORDER BY id'),
    ackCommand: db.prepare('UPDATE commands SET acked_at = ? WHERE id = ? AND device_id = ? AND acked_at IS NULL'),
  };

  function startSession(userId) {
    const token = newToken();
    const now = Date.now();
    q.insertSession.run(sha256(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  function requireUser(req) {
    const token = bearer(req);
    const user = token && q.sessionUser.get(sha256(token), Date.now());
    if (!user) throw new HttpError(401, 'يجب تسجيل الدخول');
    return user;
  }

  function requireDevice(req) {
    const token = bearer(req);
    const device = token && q.deviceByToken.get(sha256(token));
    if (!device) throw new HttpError(401, 'رمز الجهاز غير صالح');
    return device;
  }

  function ownDevice(user, id) {
    const device = q.deviceForUser.get(Number(id), user.id);
    if (!device) throw new HttpError(404, 'الجهاز غير موجود');
    return device;
  }

  function publicDevice(d) {
    const latest = q.latestReport.get(d.id) || null;
    const located = q.lastLocated.get(d.id) || null;
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.created_at,
      lastSeen: d.last_seen,
      lostMode: !!d.lost_mode,
      lostMessage: d.lost_message,
      status: latest && {
        at: latest.created_at,
        battery: latest.battery,
        charging: latest.charging === null ? null : !!latest.charging,
        network: latest.network,
        online: latest.online === null ? null : !!latest.online,
        screen: latest.screen,
      },
      location: located && {
        at: located.created_at,
        lat: located.lat,
        lng: located.lng,
        accuracy: located.accuracy,
      },
    };
  }

  // ---- route table ----
  const routes = [
    ['POST', /^\/api\/auth\/register$/, async (req) => {
      const { email, password } = await readJson(req);
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'البريد الإلكتروني غير صالح');
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        throw new HttpError(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
      }
      if (q.userByEmail.get(e)) throw new HttpError(409, 'هذا البريد مسجل بالفعل');
      const { lastInsertRowid } = q.insertUser.run(e, hashPassword(password), Date.now());
      return [201, { token: startSession(Number(lastInsertRowid)), user: { id: Number(lastInsertRowid), email: e } }];
    }],

    ['POST', /^\/api\/auth\/login$/, async (req) => {
      const { email, password } = await readJson(req);
      const e = String(email || '').trim().toLowerCase();
      const user = q.userByEmail.get(e);
      if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
        throw new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
      }
      return [200, { token: startSession(user.id), user: { id: user.id, email: user.email } }];
    }],

    ['GET', /^\/api\/config$/, async () => [200, { googleClientId }]],

    ['POST', /^\/api\/auth\/google$/, async (req) => {
      if (!googleClientId) throw new HttpError(404, 'تسجيل الدخول عبر جوجل غير مفعّل على هذا الخادم');
      const { credential } = await readJson(req);
      if (typeof credential !== 'string' || !credential) throw new HttpError(400, 'بيانات جوجل ناقصة');
      const info = await verifyGoogle(credential, googleClientId);
      if (!info || !info.emailVerified || !info.email) throw new HttpError(401, 'تعذّر التحقق من حساب جوجل');
      const email = info.email.toLowerCase();
      let user = q.userByEmail.get(email);
      if (!user) {
        // حساب جوجل بدون كلمة مرور محلية ("google" لا يطابق أي كلمة مرور)
        const { lastInsertRowid } = q.insertUser.run(email, 'google', Date.now());
        user = { id: Number(lastInsertRowid), email };
      }
      return [200, { token: startSession(user.id), user: { id: user.id, email: user.email } }];
    }],

    ['POST', /^\/api\/auth\/logout$/, async (req) => {
      const token = bearer(req);
      if (token) q.deleteSession.run(sha256(token));
      return [204];
    }],

    ['GET', /^\/api\/me$/, async (req) => [200, { user: requireUser(req) }]],

    // --- devices (owner side) ---
    ['GET', /^\/api\/devices$/, async (req) => {
      const user = requireUser(req);
      return [200, { devices: q.devicesForUser.all(user.id).map(publicDevice) }];
    }],

    ['POST', /^\/api\/devices$/, async (req) => {
      const user = requireUser(req);
      const body = await readJson(req);
      if (body.consent !== true) {
        throw new HttpError(400, 'يجب الموافقة على مشاركة موقع هذا الجهاز');
      }
      const name = (str(body.name, 60) || '').trim() || 'جهازي';
      const deviceToken = newToken();
      const { lastInsertRowid } = q.insertDevice.run(user.id, name, str(body.platform, 120), sha256(deviceToken), Date.now());
      const device = q.deviceForUser.get(Number(lastInsertRowid), user.id);
      return [201, { device: publicDevice(device), deviceToken }];
    }],

    ['PATCH', /^\/api\/devices\/(\d+)$/, async (req, [id]) => {
      const user = requireUser(req);
      ownDevice(user, id);
      const name = (str((await readJson(req)).name, 60) || '').trim();
      if (!name) throw new HttpError(400, 'الاسم مطلوب');
      q.renameDevice.run(name, Number(id), user.id);
      return [200, { device: publicDevice(ownDevice(user, id)) }];
    }],

    ['DELETE', /^\/api\/devices\/(\d+)$/, async (req, [id]) => {
      const user = requireUser(req);
      ownDevice(user, id);
      q.deleteDevice.run(Number(id), user.id);
      return [204];
    }],

    ['GET', /^\/api\/devices\/(\d+)\/history$/, async (req, [id], url) => {
      const user = requireUser(req);
      ownDevice(user, id);
      const hours = num(url.searchParams.get('hours'), 1, 24 * 30) ?? 24;
      const limit = num(url.searchParams.get('limit'), 1, 1000) ?? 300;
      const rows = q.history.all(Number(id), Date.now() - hours * 3600_000, limit);
      return [200, { points: rows.map((r) => ({ at: r.created_at, lat: r.lat, lng: r.lng, accuracy: r.accuracy, battery: r.battery })) }];
    }],

    ['POST', /^\/api\/devices\/(\d+)\/commands$/, async (req, [id]) => {
      const user = requireUser(req);
      const device = ownDevice(user, id);
      const body = await readJson(req);
      if (!COMMAND_TYPES.has(body.type)) throw new HttpError(400, 'أمر غير معروف');
      const payload = {};
      if (body.type === 'lost_mode_on') {
        payload.message = str(body.message, 300) || 'هذا الهاتف مفقود. من فضلك تواصل مع صاحبه.';
        payload.contact = str(body.contact, 100) || '';
        q.setLostMode.run(1, JSON.stringify(payload), device.id);
      } else if (body.type === 'lost_mode_off') {
        q.setLostMode.run(0, null, device.id);
      }
      const { lastInsertRowid } = q.insertCommand.run(device.id, body.type, JSON.stringify(payload), Date.now());
      return [201, { command: { id: Number(lastInsertRowid), type: body.type, payload } }];
    }],

    // --- device side (authenticated with the device token) ---
    ['POST', /^\/api\/device\/report$/, async (req) => {
      const device = requireDevice(req);
      const b = await readJson(req);
      const now = Date.now();
      let lat = num(b.lat, -90, 90);
      let lng = num(b.lng, -180, 180);
      if (lat === null || lng === null) lat = lng = null;
      const battery = num(b.battery, 0, 1);
      q.insertReport.run(
        device.id, now, lat, lng, num(b.accuracy, 0, 1e6),
        battery, bool(b.charging), str(b.network, 30), bool(b.online), str(b.screen, 20),
      );
      q.pruneReports.run(device.id, device.id, MAX_REPORTS_PER_DEVICE);
      q.touchDevice.run(now, device.id);
      return [200, { commands: pendingFor(device.id), name: device.name }];
    }],

    ['GET', /^\/api\/device\/commands$/, async (req) => {
      const device = requireDevice(req);
      q.touchDevice.run(Date.now(), device.id);
      return [200, { commands: pendingFor(device.id), name: device.name }];
    }],

    ['POST', /^\/api\/device\/commands\/(\d+)\/ack$/, async (req, [cid]) => {
      const device = requireDevice(req);
      q.ackCommand.run(Date.now(), Number(cid), device.id);
      return [204];
    }],

    // Lets the device stop sharing by itself at any time.
    ['DELETE', /^\/api\/device$/, async (req) => {
      const device = requireDevice(req);
      db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
      return [204];
    }],
  ];

  function pendingFor(deviceId) {
    return q.pendingCommands.all(deviceId).map((c) => ({
      id: c.id, type: c.type, payload: c.payload ? JSON.parse(c.payload) : {}, at: c.created_at,
    }));
  }

  async function serveStatic(req, res, pathname) {
    if (!publicDir) return false;
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(normalize(publicDir))) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
      return true;
    } catch {
      return false;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/auth/')) {
          const ip = req.socket.remoteAddress || 'unknown';
          if (!authLimit(ip)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
        }
        for (const [method, re, fn] of routes) {
          if (method !== req.method) continue;
          const m = url.pathname.match(re);
          if (!m) continue;
          const [status, body] = await fn(req, m.slice(1), url);
          return send(res, status, body);
        }
        throw new HttpError(404, 'غير موجود');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, url.pathname))) return;
      // SPA fallback
      if (req.method === 'GET' && (await serveStatic(req, res, '/index.html'))) return;
      send(res, 404, { error: 'غير موجود' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'خطأ في الخادم' });
    }
  }

  return { handle, server: createServer(handle) };
}
