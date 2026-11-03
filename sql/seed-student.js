// Creates a student user for testing the student login page.
// Run once:  node sql/seed-student.js
// Optional: STUDENT_EMAIL / STUDENT_PASSWORD / STUDENT_NAME in .env
const bcrypt = require('bcryptjs');
const pool = require('../db');

(async () => {
  const email = (process.env.STUDENT_EMAIL || 'student@college.edu').toLowerCase();
  const password = process.env.STUDENT_PASSWORD || 'Student@12345';
  const name = process.env.STUDENT_NAME || 'Test Student';

  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'student')
     ON CONFLICT (email) DO UPDATE SET name = $1, password_hash = $3`,
    [name, email, await bcrypt.hash(password, 10)]);

  console.log('Student user ready:', email);
  await pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
