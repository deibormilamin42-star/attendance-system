const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const limiter = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const { toId } = require('../lib/util');
const registrationCode = require('../lib/registrationCode');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Student login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/student/dashboard');
  res.render('student-login', { title: 'Student Login', error: null });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + email;

  if (limiter.blocked(key)) {
    return res.status(429).render('student-login', { title: 'Student Login', error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
  }

  const { rows } = await pool.query(
    'SELECT id, name, email, role, password_hash FROM users WHERE lower(email) = $1', [email]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);

  if (!u || !ok || u.role !== 'student') {
    limiter.fail(key);
    return res.status(401).render('student-login', { title: 'Student Login', error: 'Invalid email or password' });
  }

  limiter.clear(key);
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.user = { id: u.id, name: u.name, role: u.role, email: u.email };
  res.redirect('/student/dashboard');
});

router.post('/logout', async (req, res) => {
  await new Promise((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie('connect.sid');
  res.redirect('/student/login');
});

// Student dashboard (role-protected)
router.get('/dashboard', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'student') {
    return res.status(403).render('error', { title: 'Not allowed', code: 403, message: 'Student access only.' });
  }
  const student = await pool.query(
    `SELECT s.id, s.roll_no, s.name, c.name AS class_name,
            COALESCE(sec.name, '') AS section_name, COALESCE(cr.name, '') AS course_name
     FROM students s
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN student_section ss ON ss.student_id = s.id
     LEFT JOIN sections sec ON sec.id = ss.section_id
     LEFT JOIN courses cr ON cr.id = sec.course_id
     WHERE s.user_id = $1
     LIMIT 1`, [req.session.user.id]);

  const s = student.rows[0];
  if (!s) {
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('connect.sid');
    return res.redirect('/student/login');
  }

  const [parent, marks, attendance] = await Promise.all([
    pool.query('SELECT name, email, phone FROM parents WHERE student_id = $1', [s.id]),
    pool.query('SELECT attendance_pct, marks, calculated_on FROM marks WHERE student_id = $1 ORDER BY calculated_on DESC LIMIT 1', [s.id]),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('present','late')) AS attended,
              COUNT(*) AS total,
              ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('present','late')) / NULLIF(COUNT(*), 0), 1)::float8 AS pct
       FROM attendance WHERE student_id = $1`, [s.id]),
  ]);

  res.render('student-dashboard', {
    title: 'My dashboard', active: 'student',
    student: s,
    parent: parent.rows[0] || null,
    marks: marks.rows[0] || null,
    attendance,
  });
});

// --- New: Student registration ---
router.get('/register', async (req, res) => {
  if (req.session.user) return res.redirect('/student/dashboard');
  const { rows } = await pool.query('SELECT id, name FROM classes ORDER BY name');
  res.render('student-register', { title: 'Student Registration', error: null, classes: rows });
});

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email_lc = String(req.body.email || '').trim().toLowerCase();
  const pwd = String(req.body.password || '');
  const roll_no = String(req.body.roll_no || '').trim();
  const class_id = toId(req.body.class_id);
  const code = registrationCode.normalize(req.body.code);

  const fail = async (error, status = 400) => res.status(status).render('student-register', {
    title: 'Student Registration', error,
    classes: (await pool.query('SELECT id, name FROM classes ORDER BY name')).rows,
  });

  if (!name || !email_lc || !pwd || !roll_no || !class_id || !code) {
    return fail('All fields are required, including the registration code.');
  }
  if (pwd.length < 8) {
    return fail('Password must be at least 8 characters.');
  }

  // A short code can be guessed, so registration is throttled like the login page.
  // Only wrong codes count against the limit, so a shared campus address is not punished.
  const key = req.ip + '|reg|' + roll_no;
  if (limiter.blocked(key)) {
    return fail('Too many registration attempts. Please wait 15 minutes and try again.', 429);
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE lower(email) = $1', [email_lc]);
  if (existing.length) {
    return fail('A user with that email already exists.');
  }

  // The roll number must match a student the admin has already registered in this class.
  const { rows: student } = await pool.query(
    `SELECT id, user_id, registration_code_hash,
            (registration_code_expires > now()) AS code_active
     FROM students WHERE roll_no = $1 AND class_id = $2`, [roll_no, class_id]);
  if (!student.length) {
    return fail('Invalid roll number for the selected class. Please enter a roll number that the admin has registered.');
  }
  const target = student[0];
  if (target.user_id) {
    return fail('An account already exists for this roll number. Please log in instead.');
  }
  if (!target.registration_code_hash) {
    return fail('No registration code has been issued for that roll number. Ask the administrator for one.');
  }
  if (!target.code_active) {
    return fail('That registration code has expired. Ask the administrator for a new one.');
  }
  if (!(await registrationCode.matches(code, target.registration_code_hash))) {
    limiter.fail(key);
    return fail('That registration code is not correct.');
  }

  // Claim the record and create the login together, so a failure cannot consume the
  // code without creating an account, or create an account that is not linked.
  const client = await pool.connect();
  let userId;
  try {
    await client.query('BEGIN');
    const { rows: user } = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'student')
       RETURNING id`,
      [name, email_lc, await bcrypt.hash(pwd, 10)]);
    userId = user[0].id;

    const claimed = await client.query(
      `UPDATE students SET user_id = $2, registration_code_hash = NULL,
              registration_code_expires = NULL
       WHERE id = $1 AND user_id IS NULL`, [target.id, userId]);
    if (!claimed.rowCount) {
      await client.query('ROLLBACK');
      return fail('An account already exists for this roll number. Please log in instead.');
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return fail('A user with that email already exists.');
    throw e;
  } finally {
    client.release();
  }

  limiter.clear(key);

  // Log the student in
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.user = { id: userId, name, role: 'student', email: email_lc };
  res.redirect('/student/dashboard');
});

module.exports = router;
