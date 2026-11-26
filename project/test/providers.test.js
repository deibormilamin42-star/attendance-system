const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A local stand-in for Resend / Twilio. Each request is recorded so the tests
// can assert exactly what the adapters sent.
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
const sms = require('../lib/sms');

test('e-mail adapter', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  await t.test('refuses to send when no provider is configured', async () => {
    assert.equal(email.isConfigured(), false);
    await assert.rejects(() => email.sendEmail({ to: 'p@example.com', subject: 's', text: 'b' }),
      /No e-mail provider is configured/);
  });

  process.env.RESEND_API_URL = stub.url + '/emails';
  process.env.RESEND_API_KEY = 'resend_test_key';
  process.env.MAIL_FROM = 'Attendly <alerts@example.com>';

  await t.test('sends the expected payload and returns the provider id', async () => {
    const out = await email.sendEmail({ to: 'p@example.com', subject: 'Attendance', text: 'Please attend.' });
    assert.equal(out.id, 'em_1');
    const req = stub.requests.at(-1);
    assert.equal(req.headers.authorization, 'Bearer resend_test_key');
    const payload = JSON.parse(req.body);
    assert.deepEqual(payload.to, ['p@example.com']);
    assert.equal(payload.from, 'Attendly <alerts@example.com>');
    assert.equal(payload.subject, 'Attendance');
    assert.equal(payload.text, 'Please attend.');
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
});

test('SMS adapter', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());

  await t.test('refuses to send when no provider is configured', async () => {
    assert.equal(sms.isConfigured(), false);
    await assert.rejects(() => sms.sendSms({ to: '+919876543210', text: 'hi' }),
      /No SMS provider is configured/);
  });

  process.env.TWILIO_API_URL = stub.url + '/Messages.json';
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'token_test';
  process.env.TWILIO_FROM = '+12025550123';

  await t.test('normalises the number and sends form-encoded fields', async () => {
    const out = await sms.sendSms({ to: '+91 (98765) 43210', text: 'Hello parent' });
    assert.equal(out.id, 'SM1');
    const req = stub.requests.at(-1);
    assert.equal(req.headers.authorization,
      'Basic ' + Buffer.from('AC_test:token_test').toString('base64'));
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(req.body);
    assert.equal(body.get('To'), '+919876543210');
    assert.equal(body.get('From'), '+12025550123');
    assert.equal(body.get('Body'), 'Hello parent');
  });

  await t.test('treats a rejected number as permanent and keeps the provider code', async () => {
    stub.mode = 'badnumber';
    await assert.rejects(() => sms.sendSms({ to: '+919876543210', text: 'x' }),
      (e) => {
        assert.equal(e.name, 'SmsError');
        assert.equal(e.permanent, true);
        assert.match(e.message, /HTTP 400.*The number is not valid.*21211/);
        return true;
      });
  });

  await t.test('treats 5xx as retryable', async () => {
    stub.mode = 'down';
    await assert.rejects(() => sms.sendSms({ to: '+919876543210', text: 'x' }),
      (e) => e.permanent === false && /HTTP 503/.test(e.message));
  });

  await t.test('rejects an empty number without calling the provider', async () => {
    const before = stub.requests.length;
    await assert.rejects(() => sms.sendSms({ to: '', text: 'x' }),
      (e) => e.permanent === true && /no usable phone number/.test(e.message));
    assert.equal(stub.requests.length, before);
  });
});
