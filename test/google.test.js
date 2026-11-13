import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

async function withApp(opts, fn) {
  const { server } = createApp({ db: openDb(':memory:'), publicDir: null, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const res = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn(call); } finally { server.close(); }
}

const fakeVerify = async (cred) =>
  cred === 'good' ? { email: 'Me@Gmail.com', emailVerified: true }
  : cred === 'unverified' ? { email: 'x@gmail.com', emailVerified: false } : null;

test('google sign-in disabled without client id', () => withApp({}, async (call) => {
  assert.equal((await call('/api/config')).body.googleClientId, null);
  assert.equal((await call('/api/auth/google', { credential: 'good' })).status, 404);
}));

test('google sign-in creates then reuses account', () => withApp({ googleClientId: 'cid', verifyGoogle: fakeVerify }, async (call) => {
  assert.equal((await call('/api/config')).body.googleClientId, 'cid');
  const a = await call('/api/auth/google', { credential: 'good' });
  assert.equal(a.status, 200);
  assert.equal(a.body.user.email, 'me@gmail.com');
  const b = await call('/api/auth/google', { credential: 'good' });
  assert.equal(b.body.user.id, a.body.user.id);
  assert.equal((await call('/api/auth/google', { credential: 'bad' })).status, 401);
  assert.equal((await call('/api/auth/google', { credential: 'unverified' })).status, 401);
  // a Google-only account cannot be entered with a password
  assert.equal((await call('/api/auth/login', { email: 'me@gmail.com', password: 'google' })).status, 401);
}));
