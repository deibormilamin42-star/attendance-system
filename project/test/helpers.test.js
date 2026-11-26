const test = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../lib/dates');
const { clean, toId, pctClass, LOW } = require('../lib/util');
const codes = require('../lib/registrationCode');
const rate = require('../middleware/rateLimit');

test('dates.today returns an APP_TZ calendar date', () => {
  const today = dates.today();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  // Same instant, formatted through the same time zone, must agree.
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TZ || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  assert.equal(today, expected);
});

test('dates.isDate accepts real dates only', () => {
  assert.equal(dates.isDate('2024-02-29'), true); // leap year
  assert.equal(dates.isDate('2026-02-29'), false);
  assert.equal(dates.isDate('2026-13-01'), false);
  assert.equal(dates.isDate('26-11-2026'), false);
  assert.equal(dates.isDate(''), false);
  assert.equal(dates.isDate(null), false);
});

test('dates arithmetic crosses month and year boundaries', () => {
  assert.equal(dates.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dates.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(dates.daysInMonth('2024-02'), 29);
  assert.equal(dates.daysInMonth('2026-02'), 28);
  assert.equal(dates.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(dates.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(dates.monthStart('2026-11-26'), '2026-11-01');
  assert.equal(dates.isMonth('2026-11'), true);
  assert.equal(dates.isMonth('2026-13'), false);
});

test('util.clean collapses whitespace and caps length', () => {
  assert.equal(clean('  Rita   Devi  '), 'Rita Devi');
  assert.equal(clean('a\n\tb'), 'a b');
  assert.equal(clean(null), '');
  assert.equal(clean(undefined), '');
  assert.equal(clean('abcdef', 3), 'abc');
});

test('util.toId accepts only short digit ids', () => {
  assert.equal(toId('12'), 12);
  assert.equal(toId(7), 7);
  assert.equal(toId('12a'), null);
  assert.equal(toId('-1'), null);
  assert.equal(toId('1234567890'), null); // more than nine digits
  assert.equal(toId(''), null);
  assert.equal(toId(null), null);
});

test('util.pctClass switches at LOW', () => {
  assert.equal(LOW, Number(process.env.LOW_ATTENDANCE || 75));
  assert.equal(pctClass(null), '');
  assert.equal(pctClass(LOW), 'ok');
  assert.equal(pctClass(LOW - 0.1), 'bad');
});

test('registration codes are readable, hashed and single format', async () => {
  const code = codes.generate();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.doesNotMatch(code, /[01IO]/, 'ambiguous characters must not appear');
  assert.equal(codes.DAYS, 14);

  assert.equal(codes.normalize(' ab-cd ef '), 'ABCDEF');
  assert.match(codes.generate(), /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  const hash = await codes.hash(code);
  assert.match(hash, /^\$2[aby]\$/);
  assert.notEqual(hash, codes.normalize(code));

  assert.equal(await codes.matches(code, hash), true);
  assert.equal(await codes.matches(code.toLowerCase(), hash), true);
  assert.equal(await codes.matches(code.replace('-', ' '), hash), true);
  assert.equal(await codes.matches('WRONGCODE1', hash), false);
  assert.equal(await codes.matches('SHORT', hash), false);
  assert.equal(await codes.matches('', hash), false);
  assert.equal(await codes.matches(code, null), false);
});

test('rate limiter blocks after eight failures and clears', () => {
  const key = 'test|' + Math.random();
  assert.equal(rate.blocked(key), false);
  for (let i = 0; i < 7; i++) rate.fail(key);
  assert.equal(rate.blocked(key), false, 'seven failures must not block');
  rate.fail(key);
  assert.equal(rate.blocked(key), true);
  rate.clear(key);
  assert.equal(rate.blocked(key), false);
});
