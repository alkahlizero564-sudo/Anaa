import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

let server, base;

before(async () => {
  ({ server } = createApp({ db: openDb(':memory:'), publicDir: null }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const register = async (email) =>
  (await call('/api/auth/register', { method: 'POST', body: { email, password: 'secret-pass-1' } })).body.token;

test('register, login and reject bad credentials', async () => {
  const r = await call('/api/auth/register', { method: 'POST', body: { email: 'A@Example.com', password: 'secret-pass-1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.email, 'a@example.com');

  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'a@example.com', password: 'secret-pass-1' } })).status, 409);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'bad', password: 'secret-pass-1' } })).status, 400);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'b@example.com', password: 'short' } })).status, 400);

  const ok = await call('/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'secret-pass-1' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await call('/api/me', { token: ok.body.token })).body.user.email, 'a@example.com');

  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'wrong-pass' } })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
});

test('device enrollment requires consent', async () => {
  const token = await register('consent@example.com');
  const r = await call('/api/devices', { method: 'POST', token, body: { name: 'Phone' } });
  assert.equal(r.status, 400);
});

test('device reports location and battery; owner sees it', async () => {
  const token = await register('owner@example.com');
  const { body } = await call('/api/devices', { method: 'POST', token, body: { name: 'هاتفي', consent: true, platform: 'test' } });
  const dt = body.deviceToken;

  const rep = await call('/api/device/report', {
    method: 'POST', token: dt,
    body: { lat: 30.0444, lng: 31.2357, accuracy: 12, battery: 0.42, charging: false, online: true, network: 'wifi', screen: 'visible' },
  });
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.commands, []);

  // A later report without a fix keeps the last known location.
  await call('/api/device/report', { method: 'POST', token: dt, body: { battery: 0.40, online: true } });

  const list = await call('/api/devices', { token });
  const d = list.body.devices[0];
  assert.equal(d.name, 'هاتفي');
  assert.equal(d.status.battery, 0.40);
  assert.equal(d.location.lat, 30.0444);
  assert.equal(d.location.accuracy, 12);
  assert.ok(d.lastSeen);

  const hist = await call(`/api/devices/${d.id}/history`, { token });
  assert.equal(hist.body.points.length, 1);

  // invalid coordinates are dropped
  await call('/api/device/report', { method: 'POST', token: dt, body: { lat: 999, lng: 31 } });
  assert.equal((await call(`/api/devices/${d.id}/history`, { token })).body.points.length, 1);
});

test('commands are delivered once and lost mode is tracked', async () => {
  const token = await register('cmd@example.com');
  const { body } = await call('/api/devices', { method: 'POST', token, body: { name: 'P', consent: true } });
  const id = body.device.id;
  const dt = body.deviceToken;

  assert.equal((await call(`/api/devices/${id}/commands`, { method: 'POST', token, body: { type: 'nope' } })).status, 400);
  await call(`/api/devices/${id}/commands`, { method: 'POST', token, body: { type: 'ring' } });
  await call(`/api/devices/${id}/commands`, { method: 'POST', token, body: { type: 'lost_mode_on', message: 'رجّعه', contact: '+201000000000' } });

  const pending = (await call('/api/device/commands', { token: dt })).body.commands;
  assert.deepEqual(pending.map((c) => c.type), ['ring', 'lost_mode_on']);
  assert.equal(pending[1].payload.message, 'رجّعه');

  for (const c of pending) await call(`/api/device/commands/${c.id}/ack`, { method: 'POST', token: dt });
  assert.deepEqual((await call('/api/device/commands', { token: dt })).body.commands, []);

  assert.equal((await call('/api/devices', { token })).body.devices[0].lostMode, true);
  await call(`/api/devices/${id}/commands`, { method: 'POST', token, body: { type: 'lost_mode_off' } });
  assert.equal((await call('/api/devices', { token })).body.devices[0].lostMode, false);
});

test('users cannot see or control other users\' devices', async () => {
  const a = await register('a2@example.com');
  const b = await register('b2@example.com');
  const { body } = await call('/api/devices', { method: 'POST', token: a, body: { name: 'A phone', consent: true } });
  const id = body.device.id;

  assert.deepEqual((await call('/api/devices', { token: b })).body.devices, []);
  assert.equal((await call(`/api/devices/${id}/history`, { token: b })).status, 404);
  assert.equal((await call(`/api/devices/${id}/commands`, { method: 'POST', token: b, body: { type: 'ring' } })).status, 404);
  assert.equal((await call(`/api/devices/${id}`, { method: 'DELETE', token: b })).status, 404);
  // a user token is not a device token
  assert.equal((await call('/api/device/report', { method: 'POST', token: a, body: {} })).status, 401);
});

test('device can stop sharing by itself', async () => {
  const token = await register('stop@example.com');
  const { body } = await call('/api/devices', { method: 'POST', token, body: { name: 'P', consent: true } });
  assert.equal((await call('/api/device', { method: 'DELETE', token: body.deviceToken })).status, 204);
  assert.deepEqual((await call('/api/devices', { token })).body.devices, []);
  assert.equal((await call('/api/device/commands', { token: body.deviceToken })).status, 401);
});
