const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const limiter = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

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
  const [student, parent, marks, attendance] = await Promise.all([
    pool.query(
      `SELECT s.id, s.roll_no, s.name, c.name AS class_name,
              COALESCE(sec.name, '') AS section_name, COALESCE(cr.name, '') AS course_name
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN student_section ss ON ss.student_id = s.id
       LEFT JOIN sections sec ON sec.id = ss.section_id
       LEFT JOIN courses cr ON cr.id = sec.course_id
       WHERE s.id = $1`, [req.session.user.id]),
    pool.query('SELECT name, email, phone FROM parents WHERE student_id = $1', [req.session.user.id]),
    pool.query('SELECT attendance_pct, marks, calculated_on FROM marks WHERE student_id = $1 ORDER BY calculated_on DESC LIMIT 1', [req.session.user.id]),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('present','late')) AS attended,
              COUNT(*) AS total,
              ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('present','late')) / NULLIF(COUNT(*), 0), 1)::float8 AS pct
       FROM attendance WHERE student_id = $1`, [req.session.user.id]),
  ]);

  const s = student.rows[0];
  if (!s) {
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('connect.sid');
    return res.redirect('/student/login');
  }

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
  const { name, email, password, roll_no, class_id } = req.body;
  const email_lc = String(email || '').trim().toLowerCase();
  const pwd = String(password || '');

  // Basic validation
  if (!name || !email_lc || !pwd || !roll_no || !class_id) {
    return res.status(400).render('student-register', { title: 'Student Registration', error: 'All fields are required.', classes: [] });
  }
  if (pwd.length < 8) {
    return res.status(400).render('student-register', { title: 'Student Registration', error: 'Password must be at least 8 characters.', classes: await pool.query('SELECT id, name FROM classes ORDER BY name') });
  }

  // Check if email already exists
  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE lower(email) = $1', [email_lc]);
  if (existing.length) {
    return res.status(400).render('student-register', { title: 'Student Registration', error: 'A user with that email already exists.', classes: await pool.query('SELECT id, name FROM classes ORDER BY name') });
  }

  // Check if roll_no exists for the selected class
  const { rows: student } = await pool.query(
    'SELECT id, name FROM students WHERE roll_no = $1 AND class_id = $2', [roll_no, class_id]);
  if (!student.length) {
    return res.status(400).render('student-register', { title: 'Student Registration', error: 'Invalid roll number for the selected class. Please enter a roll number that the admin has registered.', classes: await pool.query('SELECT id, name FROM classes ORDER BY name') });
  }

  // Check if roll_no is already taken by another student (unique constraint)
  const { rows: taken } = await pool.query(
    'SELECT id FROM students WHERE roll_no = $1 AND id != $2', [roll_no, student[0].id]);
  if (taken.length) {
    return res.status(400).render('student-register', { title: 'Student Registration', error: 'This roll number is already taken. Please enter a different roll number.', classes: await pool.query('SELECT id, name FROM classes ORDER BY name') });
  }

  // Hash password
  const password_hash = await bcrypt.hash(pwd, 10);

  // Insert into users first, then students (using the generated id)
  const { rows: user } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'student') RETURNING id`,
    [name, email_lc, password_hash]
  );
  const student_id = user.rows[0].id;

  await pool.query(
    `INSERT INTO students (roll_no, name, class_id) VALUES ($1, $2, $3)`,
    [roll_no, name, class_id]
  );

  // Log the student in
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.user = { id: student_id, name, role: 'student', email: email_lc };
  res.redirect('/student/dashboard');
});

module.exports = router;
