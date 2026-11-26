// Creates a student user and links it to an existing student record, so that the
// student login has a record of its own to display.
// Run once:  node sql/seed-student.js
// Optional: STUDENT_EMAIL / STUDENT_PASSWORD / STUDENT_NAME in .env
// Optional: STUDENT_ROLL_NO to choose which unlinked student the login is attached to.
const bcrypt = require('bcryptjs');
const pool = require('../db');

(async () => {
  const email = (process.env.STUDENT_EMAIL || 'student@college.edu').toLowerCase();
  const password = process.env.STUDENT_PASSWORD || 'Student@12345';
  const name = process.env.STUDENT_NAME || 'Test Student';
  const roll = (process.env.STUDENT_ROLL_NO || '').trim();

  const { rows: user } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'student')
     ON CONFLICT (email) DO UPDATE SET name = $1, password_hash = $3
     RETURNING id`,
    [name, email, await bcrypt.hash(password, 10)]);
  const userId = user[0].id;

  // Already linked (re-run): leave the existing link alone.
  const linked = await pool.query('SELECT id, roll_no FROM students WHERE user_id = $1', [userId]);
  if (linked.rows[0]) {
    console.log(`Student user ready: ${email} -> roll ${linked.rows[0].roll_no}`);
    await pool.end();
    return;
  }

  const { rows: students } = await pool.query(
    `SELECT id, roll_no FROM students
     WHERE user_id IS NULL AND ($1::text = '' OR roll_no = $1)
     ORDER BY LENGTH(roll_no), roll_no
     LIMIT 1`, [roll]);

  if (!students.length) {
    console.error(`Student user ready: ${email}`);
    console.error(roll
      ? `No unlinked student with roll number ${roll}. Check the roll number or free it from another login.`
      : 'No unlinked student record found. Create a student first, or set STUDENT_ROLL_NO to an existing unlinked roll number.');
    await pool.end();
    process.exit(1);
  }

  await pool.query('UPDATE students SET user_id = $1 WHERE id = $2', [userId, students[0].id]);
  console.log(`Student user ready: ${email} -> roll ${students[0].roll_no}`);
  await pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
