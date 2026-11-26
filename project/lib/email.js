// Sends e-mail through Resend's REST API. No SDK: Node 20 ships fetch.
// Delivery is disabled unless RESEND_API_KEY and MAIL_FROM are set, in which
// case the worker leaves every message 'pending' instead of pretending.
const API_URL = () => process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const apiKey = () => process.env.RESEND_API_KEY || '';
const from = () => process.env.MAIL_FROM || '';
const TIMEOUT_MS = 10000;

const isConfigured = () => Boolean(apiKey() && from());

class EmailError extends Error {
  // permanent = retrying the same request cannot succeed (bad address,
  // unverified domain, missing configuration).
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'EmailError';
    this.permanent = permanent;
  }
}

function providerMessage(res, raw, data) {
  const fromBody = data && (typeof data.message === 'string' ? data.message
    : typeof data.error === 'string' ? data.error
      : data.error ? JSON.stringify(data.error) : null);
  return fromBody || raw.slice(0, 200) || `HTTP ${res.status}`;
}

async function sendEmail({ to, subject, text }) {
  if (!isConfigured()) {
    throw new EmailError('No e-mail provider is configured (set RESEND_API_KEY and MAIL_FROM).');
  }
  if (!to) throw new EmailError('The parent has no e-mail address on file.', { permanent: true });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from(), to: [to], subject, text }),
      signal: ctl.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* provider returned HTML */ }

    if (res.ok) return { id: (data && (data.id || data.message_id)) || null };

    // 429 and 5xx are worth another attempt; other 4xx are not.
    const retryable = res.status === 429 || res.status >= 500;
    throw new EmailError(`Provider rejected the message (HTTP ${res.status}): ${providerMessage(res, raw, data)}`,
      { permanent: !retryable });
  } catch (e) {
    if (e instanceof EmailError) throw e;
    if (e.name === 'AbortError') {
      throw new EmailError(`The e-mail provider did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    }
    throw new EmailError(`Could not reach the e-mail provider: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, sendEmail, EmailError };
