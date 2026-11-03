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

module.exports = router;
