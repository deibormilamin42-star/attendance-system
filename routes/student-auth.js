const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const limiter = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const { toId } = require('../lib/util');

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
     WHERE s.user_id = $1 OR (s.user_id IS NULL AND s.id = $1)
     ORDER BY (s.user_id = $1) DESC
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

  const fail = async (error) => res.status(400).render('student-register', {
    title: 'Student Registration', error,
    classes: (await pool.query('SELECT id, name FROM classes ORDER BY name')).rows,
  });

  if (!name || !email_lc || !pwd || !roll_no || !class_id) {
    return fail('All fields are required.');
  }
  if (pwd.length < 8) {
    return fail('Password must be at least 8 characters.');
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE lower(email) = $1', [email_lc]);
  if (existing.length) {
    return fail('A user with that email already exists.');
  }

  // The roll number must match a student the admin has already registered in this class.
  const { rows: student } = await pool.query(
    'SELECT id, user_id FROM students WHERE roll_no = $1 AND class_id = $2', [roll_no, class_id]);
  if (!student.length) {
    return fail('Invalid roll number for the selected class. Please enter a roll number that the admin has registered.');
  }
  const target = student[0];
  if (target.user_id) {
    return fail('An account already exists for this roll number. Please log in instead.');
  }

  const password_hash = await bcrypt.hash(pwd, 10);

  const { rows: user } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'student') RETURNING id`,
    [name, email_lc, password_hash]
  );
  const student_id = user[0].id;

  // Attach the new login to the student record the admin already created.
  await pool.query('UPDATE students SET user_id = $2 WHERE id = $1', [target.id, student_id]);

  // Log the student in
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.user = { id: student_id, name, role: 'student', email: email_lc };
  res.redirect('/student/dashboard');
});

module.exports = router;
