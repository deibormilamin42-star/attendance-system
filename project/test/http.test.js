const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// These exercise the real Express app in a child process. No database is
// needed: the public pages do not touch it, and the session store's failure to
// connect is logged without taking the process down.
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');

let child;
let output = '';

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (output.includes('Server running')) return;
    if (child.exitCode !== null) throw new Error('server exited early:\n' + output);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + output);
});

test.after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

test('health check answers without creating a session', async () => {
  const res = await fetch(BASE + '/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('login page renders with a CSRF token', async () => {
  const res = await fetch(BASE + '/login');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /name="_csrf"/);
  assert.match(html, /value="[a-f0-9]{48}"/);
});

test('a protected page redirects to the login', async () => {
  const res = await fetch(BASE + '/dashboard', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('a POST without a CSRF token is rejected', async () => {
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=a%40b.c&password=x',
    redirect: 'manual',
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /form expired or was invalid/i);
});

test('unknown URLs get the custom 404 page', async () => {
  const res = await fetch(BASE + '/nope');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /does not exist/);
});

test('security headers and static assets are served', async () => {
  const head = await fetch(BASE + '/login', { method: 'HEAD' });
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(head.headers.get('x-frame-options'), 'SAMEORIGIN');

  const css = await fetch(BASE + '/css/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});
