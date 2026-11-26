// Sends SMS through Twilio's REST API. No SDK: Node 20 ships fetch.
// Delivery is disabled unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM are set; the worker then leaves SMS messages pending.
const accountSid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';
const from = () => process.env.TWILIO_FROM || '';
const TIMEOUT_MS = 10000;

const apiUrl = () => process.env.TWILIO_API_URL ||
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid())}/Messages.json`;

const isConfigured = () => Boolean(accountSid() && authToken() && from());

// Twilio wants E.164; strip the spaces, dashes and brackets people type.
const e164 = (v) => String(v || '').replace(/[^\d+]/g, '');

class SmsError extends Error {
  // permanent = retrying the same request cannot succeed (bad number,
  // unverified sender, missing configuration).
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'SmsError';
    this.permanent = permanent;
  }
}

function providerMessage(res, raw, data) {
  if (data && (data.message || data.code)) {
    return `${data.message || 'rejected'}${data.code ? ` (code ${data.code})` : ''}`;
  }
  return raw.slice(0, 200) || `HTTP ${res.status}`;
}

async function sendSms({ to, text }) {
  if (!isConfigured()) {
    throw new SmsError('No SMS provider is configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM).');
  }
  const number = e164(to);
  if (!number) throw new SmsError('The parent has no usable phone number on file.', { permanent: true });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: number, From: from(), Body: text }),
      signal: ctl.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* provider returned HTML */ }

    if (res.ok) return { id: (data && (data.sid || data.message_sid)) || null, status: data && data.status };

    // 429 and 5xx are worth another attempt; other 4xx (bad number, blocked
    // destination, bad credentials) are not.
    const retryable = res.status === 429 || res.status >= 500;
    throw new SmsError(`Provider rejected the message (HTTP ${res.status}): ${providerMessage(res, raw, data)}`,
      { permanent: !retryable });
  } catch (e) {
    if (e instanceof SmsError) throw e;
    if (e.name === 'AbortError') {
      throw new SmsError(`The SMS provider did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    }
    throw new SmsError(`Could not reach the SMS provider: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, sendSms, SmsError, e164 };
