const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A local stand-in for Brevo's SMTP API. Each request is recorded so the tests
// can assert exactly what the adapter sent.
function startStub() {
  const stub = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stub.requests.push({ url: req.url, headers: req.headers, body });
      if (stub.mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'em_1', sid: 'SM1' }));
      } else if (stub.mode === 'invalid') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Invalid to field' }));
      } else if (stub.mode === 'badnumber') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 21211, message: 'The number is not valid' }));
      } else if (stub.mode === 'down') {
        res.writeHead(503);
        res.end('unavailable');
      } else {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html>oops</html>');
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

const email = require('../lib/email');

test('e-mail adapter', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  await t.test('refuses to send when no provider is configured', async () => {
    assert.equal(email.isConfigured(), false);
    await assert.rejects(() => email.sendEmail({ to: 'p@example.com', subject: 's', text: 'b' }),
      /No e-mail provider is configured/);
  });

  process.env.BREVO_API_URL = stub.url + '/v3/smtp/email';
  process.env.BREVO_API_KEY = 'brevo_test_key';
  process.env.MAIL_FROM = 'Attendly <alerts@example.com>';

  await t.test('sends the expected Brevo payload and returns the provider id', async () => {
    const out = await email.sendEmail({ to: 'p@example.com', subject: 'Attendance', text: 'Please attend.' });
    assert.equal(out.id, 'em_1');
    const req = stub.requests.at(-1);
    assert.equal(req.headers['api-key'], 'brevo_test_key');
    assert.equal(req.headers['content-type'], 'application/json');
    const payload = JSON.parse(req.body);
    assert.deepEqual(payload.sender, { email: 'alerts@example.com', name: 'Attendly' });
    assert.deepEqual(payload.to, [{ email: 'p@example.com' }]);
    assert.equal(payload.subject, 'Attendance');
    assert.equal(payload.textContent, 'Please attend.');
  });

  await t.test('treats a 4xx rejection as permanent', async () => {
    stub.mode = 'invalid';
    await assert.rejects(() => email.sendEmail({ to: 'x@example.com', subject: 's', text: 'b' }),
      (e) => {
        assert.equal(e.name, 'EmailError');
        assert.equal(e.permanent, true);
        assert.match(e.message, /HTTP 422.*Invalid to field/);
        return true;
      });
  });

  await t.test('treats 429, 5xx and non-JSON errors as retryable', async () => {
    stub.mode = 'down';
    await assert.rejects(() => email.sendEmail({ to: 'x@example.com', subject: 's', text: 'b' }),
      (e) => e.permanent === false && /HTTP 503/.test(e.message));
    stub.mode = 'html';
    await assert.rejects(() => email.sendEmail({ to: 'x@example.com', subject: 's', text: 'b' }),
      (e) => e.permanent === false && /HTTP 500/.test(e.message));
  });

  await t.test('fails permanently when the parent has no address', async () => {
    await assert.rejects(() => email.sendEmail({ to: '', subject: 's', text: 'b' }),
      (e) => e.permanent === true && /no e-mail address/.test(e.message));
  });

  await t.test('fails permanently when MAIL_FROM is not a valid address', async () => {
    process.env.MAIL_FROM = 'not-an-email';
    await assert.rejects(() => email.sendEmail({ to: 'p@example.com', subject: 's', text: 'b' }),
      (e) => e.permanent === true && /valid e-mail address/.test(e.message));
    process.env.MAIL_FROM = 'Attendly <alerts@example.com>';
  });
});
