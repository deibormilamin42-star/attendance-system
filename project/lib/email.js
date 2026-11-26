// Sends e-mail through Brevo's SMTP API. No SDK: Node 18+ ships fetch.
// Delivery is disabled unless BREVO_API_KEY and MAIL_FROM are both set.
const TIMEOUT_MS = 15000;
 
// Render/dashboards often add stray spaces, newlines or quotes when a value is pasted.
const clean = (v) => String(v || '').trim();
const API_URL = () => clean(process.env.BREVO_API_URL) || 'https://api.brevo.com/v3/smtp/email';
const apiKey = () => clean(process.env.BREVO_API_KEY).replace(/^["']+|["']+$/g, '');
const fromRaw = () => clean(process.env.MAIL_FROM);
 
// Parse "Name <email@host>" or just "email@host" into { name, email }.
const parseFrom = (raw) => {
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(String(raw || '').trim());
  if (match) {
    const name = match[1].trim().replace(/^["']+|["']+$/g, '').trim();
    return { name: name || undefined, email: match[2].trim() };
  }
  const email = String(raw || '').trim();
  return email ? { email } : { email: '' };
};
 
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (v) => EMAIL_RE.test(String(v || ''));
 
const isConfigured = () => Boolean(apiKey() && parseFrom(fromRaw()).email);
 
// Which settings are missing, e.g. "MAIL_FROM". Empty string when configured.
const missingConfig = () => [
  !apiKey() && 'BREVO_API_KEY',
  !parseFrom(fromRaw()).email && 'MAIL_FROM',
].filter(Boolean).join(' and ');
 
class EmailError extends Error {
  // permanent = retrying the same request cannot succeed.
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
 
// Plain-English next step for the Brevo errors people hit most often.
function hintFor(status, message) {
  if (status === 401 || status === 403) {
    return ' Check that BREVO_API_KEY is a v3 API key (starts with "xkeysib-", not an SMTP key "xsmtpsib-") '
      + "and, if Brevo's Security > Authorized IPs is on, turn it off (Render's outbound IPs change).";
  }
  if (/sender/i.test(message)) {
    return ' MAIL_FROM must be exactly the sender (or a sender on the domain) you validated in Brevo.';
  }
  return '';
}
 
async function sendEmail({ to, subject, text }) {
  if (!isConfigured()) {
    throw new EmailError(`No e-mail provider is configured (set BREVO_API_KEY and MAIL_FROM). Missing: ${missingConfig()}.`);
  }
  if (typeof fetch !== 'function') {
    throw new EmailError('This Node version has no fetch(). Use Node 18 or newer (set NODE_VERSION on Render).',
      { permanent: true });
  }
  if (!to) throw new EmailError('The parent has no e-mail address on file.', { permanent: true });
  if (!isValidEmail(to)) throw new EmailError(`"${to}" is not a valid e-mail address.`, { permanent: true });
 
  const { email: fromEmail, name: fromName } = parseFrom(fromRaw());
  if (!isValidEmail(fromEmail)) throw new EmailError('MAIL_FROM is not a valid e-mail address.', { permanent: true });
 
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: { 'api-key': apiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
      signal: ctl.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* provider returned HTML */ }
 
    if (res.ok) return { id: (data && (data.messageId || data.id)) || null };
 
    const msg = providerMessage(res, raw, data);
    const retryable = res.status === 429 || res.status >= 500;
    throw new EmailError(`Provider rejected the message (HTTP ${res.status}): ${msg}.${hintFor(res.status, msg)}`.replace('..', '.'),
      { permanent: !retryable });
  } catch (e) {
    if (e instanceof EmailError) throw e;
    if (e.name === 'AbortError') {
      throw new EmailError(`The e-mail provider did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    }
    // fetch() hides the real reason (DNS, TLS, refused) in e.cause.
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    throw new EmailError(`Could not reach the e-mail provider: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}
 
module.exports = { isConfigured, missingConfig, sendEmail, EmailError };
 