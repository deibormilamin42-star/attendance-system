const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const pool = require('../db');
const dates = require('../lib/dates');

// The worker talks to the database only through pool.query, so replacing that
// one function lets these tests exercise the delivery logic without Postgres.
const queries = [];
pool.query = async (text, params) => {
  queries.push({ text, params });
  return { rows: [] };
};

const worker = require('../worker/send-messages');

function startStub(initialMode = 'ok') {
  const stub = { mode: initialMode, requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stub.requests.push(body);
      if (stub.mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'em_1', sid: 'SM1' }));
      } else if (stub.mode === 'badnumber') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 21211, message: 'The number is not valid' }));
      } else {
        res.writeHead(503);
        res.end('down');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      stub.close = () => server.close();
      stub.url = `http://127.0.0.1:${server.address().port}`;
      resolve(stub);
    });
  });
}

test('channel targets', () => {
  assert.deepEqual(worker.targetsFor(), ['email']);
});

test('claim selects pending rows by channel with SKIP LOCKED', async () => {
  queries.length = 0;
  await worker.claim(['email']);
  const q = queries.at(-1);
  assert.match(q.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(q.text, /channel = ANY\(\$3::text\[\]\)/);
  assert.match(q.text, /next_attempt_at IS NULL OR next_attempt_at <= now\(\)/,
    'rows waiting for their backoff must not be claimed');
  assert.deepEqual(q.params, [worker.MAX_ATTEMPTS, Number(process.env.MAIL_BATCH || 20), ['email']]);
});

test('backoff doubles per attempt and is capped', () => {
  assert.equal(worker.backoffMs(1), worker.BACKOFF_BASE_MS);
  assert.equal(worker.backoffMs(2), worker.BACKOFF_BASE_MS * 2);
  assert.equal(worker.backoffMs(3), worker.BACKOFF_BASE_MS * 4);
  assert.equal(worker.backoffMs(4), worker.BACKOFF_BASE_MS * 8);
  assert.equal(worker.backoffMs(40), worker.BACKOFF_MAX_MS);
  assert.ok(worker.BACKOFF_MAX_MS >= worker.BACKOFF_BASE_MS);
});

test('sending only happens on channels that were requested', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  process.env.BREVO_API_URL = stub.url + '/v3/smtp/email';
  process.env.BREVO_API_KEY = 'k';
  process.env.MAIL_FROM = 'A <a@b.c>';

  const row = {
    id: 1, channel: 'email', subject: 'Attendance', body: 'Please attend.',
    parent_email: 'p@example.com',
    email_sent_at: null,
  };

  queries.length = 0;
  stub.requests.length = 0;
  const out = await worker.deliver(row);
  assert.equal(out.ok, true);
  assert.deepEqual(out.delivered, ['email']);
  assert.equal(stub.requests.length, 1);
  const stamps = queries.map((q) => q.text).join('\n');
  assert.match(stamps, /SET email_sent_at = now\(\)/);

  // A retry must not re-send the channel that is already confirmed.
  stub.requests.length = 0;
  const retry = await worker.deliver({ ...row, email_sent_at: new Date() });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.delivered, ['email']);
  assert.equal(stub.requests.length, 0, 'no e-mail should be sent again');
});

test('a permanent e-mail failure marks the message failed', async (t) => {
  const stub = await startStub('badnumber');
  t.after(() => stub.close());
  process.env.BREVO_API_URL = stub.url + '/v3/smtp/email';

  const row = {
    id: 2, channel: 'email', subject: 'S', body: 'B',
    parent_email: 'p@example.com',
    email_sent_at: null,
  };

  const out = await worker.deliver(row);
  assert.equal(out.ok, false);
  assert.equal(out.permanent, true);
  assert.deepEqual(out.delivered, []);
  assert.equal(stub.requests.length, 1);
});

test('record marks sent only on success and fails only when retrying is hopeless', async () => {
  const row = (attempts) => ({ id: 3, attempts });

  queries.length = 0;
  assert.equal(await worker.record(row(1), { ok: true, delivered: ['email'], error: '' }), 'sent');
  let q = queries.at(-1);
  assert.match(q.text, /SET status = 'sent', sent_on = \$2, last_error = NULL/);
  assert.match(q.text, /next_attempt_at = NULL/);
  assert.equal(q.params[1], dates.today());

  const before = Date.now();
  assert.equal(await worker.record(row(2), { ok: false, permanent: false, delivered: [], error: 'email: timeout' }), 'retry');
  q = queries.at(-1);
  assert.match(q.text, /SET last_error = \$2, next_attempt_at = \$3/);
  assert.doesNotMatch(q.text, /status = 'failed'/);
  assert.ok(q.params[2] instanceof Date, 'a retry must be scheduled');
  const delay = q.params[2].getTime() - before;
  assert.ok(delay >= worker.backoffMs(2) - 1000 && delay <= worker.backoffMs(2) + 1000,
    `expected about ${worker.backoffMs(2)} ms, got ${delay}`);

  assert.equal(await worker.record(row(1), { ok: false, permanent: true, delivered: ['email'], error: 'bad' }), 'failed');
  q = queries.at(-1);
  assert.match(q.text, /SET status = 'failed'/);
  assert.match(q.text, /next_attempt_at = NULL/);
  assert.match(q.params[1], /^Delivered: email\. bad$/);

  assert.equal(await worker.record(row(worker.MAX_ATTEMPTS), { ok: false, permanent: false, delivered: [], error: 'x' }), 'failed',
    'attempt limit must end with failed');
});
