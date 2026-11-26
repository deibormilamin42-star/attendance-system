#!/usr/bin/env node
// Delivers queued parent messages and records what actually happened.
//
//   npm run worker          keep running, one pass per minute
//   npm run worker:once     a single pass (cron, or a manual run)
//
// E-mail and SMS are delivered independently. A message is marked 'sent' only
// when every channel it asks for has been accepted by its provider, and
// 'failed' only on a permanent error or when the attempt limit is reached.
// Transient errors leave it 'pending' for the next pass. With no provider
// configured the worker does nothing at all, so nothing is falsely marked.
require('dotenv').config();
const pool = require('../db');
const dates = require('../lib/dates');
const mail = require('../lib/email');
const sms = require('../lib/sms');

const BATCH = Number(process.env.MAIL_BATCH || 20);
const MAX_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS || 5);
const INTERVAL_MS = Number(process.env.MAIL_INTERVAL_MS || 60000);
const BACKOFF_BASE_MS = Number(process.env.MAIL_BACKOFF_BASE_MS || 60000);
const BACKOFF_MAX_MS = Number(process.env.MAIL_BACKOFF_MAX_MS || 3600000);
const SMS_MAX = 640;

// 1 min, 2, 4, 8 ... capped, measured from the attempt that just failed.
const backoffMs = (attempts) => Math.min(BACKOFF_MAX_MS,
  BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

// Which channel values can be attempted with the providers that are configured:
// 'both' needs both providers, a single-channel message needs its own.
const CHANNEL_COLUMNS = { email: 'email_sent_at', sms: 'sms_sent_at' };

function claimableChannels() {
  const list = [];
  if (mail.isConfigured()) list.push('email');
  if (sms.isConfigured()) list.push('sms');
  if (mail.isConfigured() && sms.isConfigured()) list.push('both');
  return list;
}

// Take a batch of pending messages and bump their attempt counter in one
// statement. SKIP LOCKED means two workers never deliver the same message, and
// the channel filter keeps messages we cannot deliver yet untouched.
async function claim(channels) {
  const { rows } = await pool.query(
    `UPDATE messages m
        SET attempts = m.attempts + 1
      WHERE m.id IN (
              SELECT id FROM messages
               WHERE status = 'pending' AND attempts < $1
                 AND channel = ANY($3::text[])
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
               ORDER BY id
               FOR UPDATE SKIP LOCKED
               LIMIT $2)
      RETURNING m.id, m.subject, m.body, m.channel, m.attempts,
                m.email_sent_at, m.sms_sent_at, m.next_attempt_at,
                (SELECT email FROM parents WHERE id = m.parent_id) AS parent_email,
                (SELECT phone FROM parents WHERE id = m.parent_id) AS parent_phone`,
    [MAX_ATTEMPTS, BATCH, channels]);
  return rows;
}

const targetsFor = (channel) => (channel === 'both' ? ['email', 'sms'] : [channel]);

const addressOf = (row, channel) => (channel === 'email' ? row.parent_email : row.parent_phone);
const missingAddress = (channel) => (channel === 'email'
  ? 'The parent has no e-mail address on file.'
  : 'The parent has no phone number on file.');

// SMS has no subject line, so fold it into the text and stay within a few parts.
function smsText(row) {
  const text = `${row.subject}\n\n${row.body}`.trim();
  return text.length > SMS_MAX ? `${text.slice(0, SMS_MAX - 3)}...` : text;
}

// Send on one channel and normalise both adapters' errors into one shape.
async function sendOnChannel(row, channel) {
  const to = addressOf(row, channel);
  if (!to) return { ok: false, permanent: true, error: missingAddress(channel) };
  try {
    const sent = channel === 'email'
      ? await mail.sendEmail({ to, subject: row.subject, text: row.body })
      : await sms.sendSms({ to, text: smsText(row) });
    return { ok: true, providerId: sent.id };
  } catch (e) {
    if (e.name !== 'EmailError' && e.name !== 'SmsError') throw e;
    return { ok: false, permanent: e.permanent, error: e.message };
  }
}

// Send only the channels that are not confirmed yet, so a retry after a
// partial failure never sends the same message twice.
async function deliver(row) {
  const results = [];
  for (const channel of targetsFor(row.channel)) {
    if (row[CHANNEL_COLUMNS[channel]]) {
      results.push({ channel, ok: true, already: true });
      continue;
    }
    const result = await sendOnChannel(row, channel);
    if (result.ok) {
      await pool.query(`UPDATE messages SET ${CHANNEL_COLUMNS[channel]} = now() WHERE id = $1`, [row.id]);
    }
    results.push({ channel, ...result });
  }

  const failures = results.filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    permanent: failures.length > 0 && failures.every((f) => f.permanent),
    delivered: results.filter((r) => r.ok).map((r) => r.channel),
    error: failures.map((f) => `${f.channel}: ${f.error}`).join('; '),
  };
}

const note = (r) => `${r.delivered.length ? `Delivered: ${r.delivered.join(', ')}. ` : ''}${r.error}`;

async function record(row, result) {
  if (result.ok) {
    await pool.query(
      `UPDATE messages SET status = 'sent', sent_on = $2, last_error = NULL,
              next_attempt_at = NULL
        WHERE id = $1`,
      [row.id, dates.today()]);
    return 'sent';
  }
  if (result.permanent || row.attempts >= MAX_ATTEMPTS) {
    await pool.query(`UPDATE messages SET status = 'failed', last_error = $2,
                             next_attempt_at = NULL WHERE id = $1`,
      [row.id, note(result).slice(0, 500)]);
    return 'failed';
  }
  const next = new Date(Date.now() + backoffMs(row.attempts));
  await pool.query(`UPDATE messages SET last_error = $2, next_attempt_at = $3 WHERE id = $1`,
    [row.id, note(result).slice(0, 500), next]);
  return 'retry';
}

async function runOnce() {
  const channels = claimableChannels();
  if (!channels.length) {
    return {
      skipped: 'No e-mail or SMS provider configured (RESEND_API_KEY / MAIL_FROM / ' +
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM); messages stay pending.',
    };
  }
  const rows = await claim(channels);
  const tally = { claimed: rows.length, sent: 0, failed: 0, retry: 0 };
  for (const row of rows) {
    const outcome = await record(row, await deliver(row));
    tally[outcome] += 1;
  }
  return tally;
}

const summary = (t) => t.skipped
  ? t.skipped
  : `claimed ${t.claimed}, sent ${t.sent}, failed ${t.failed}, retry ${t.retry}`;

async function main() {
  if (process.argv.includes('--once')) {
    console.log(summary(await runOnce()));
    await pool.end();
    return;
  }

  const channels = claimableChannels();
  console.log('Message worker started' +
    (channels.length
      ? ` (channels ${channels.join(', ')}; batch ${BATCH}, every ${INTERVAL_MS} ms)`
      : ' — no provider configured, messages stay pending'));

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = await runOnce();
      if (t.claimed || t.skipped) console.log(new Date().toISOString(), summary(t));
    } catch (e) {
      console.error('Worker pass failed:', e.message);
    } finally {
      busy = false;
    }
  };

  await tick();
  const timer = setInterval(tick, INTERVAL_MS);

  const stop = async (sig) => {
    console.log(`${sig} received, stopping after the current pass`);
    clearInterval(timer);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error('Worker stopped:', e.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  runOnce, claim, deliver, record, sendOnChannel, targetsFor, smsText,
  backoffMs, MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
};
