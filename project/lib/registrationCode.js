// One-time registration codes that let a student claim an existing student record.
// Only a bcrypt hash is stored; the plain code is shown to the administrator once.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// No 0/O/1/I, so a code can be read aloud or copied by hand without ambiguity.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 10;

exports.DAYS = 14;

exports.generate = () => {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code.slice(0, 5) + '-' + code.slice(5);
};

exports.normalize = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

exports.hash = (code) => bcrypt.hash(exports.normalize(code), 10);

exports.matches = async (input, hash) => {
  const code = exports.normalize(input);
  if (!hash || code.length !== LENGTH) return false;
  return bcrypt.compare(code, hash);
};
