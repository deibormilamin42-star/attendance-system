const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { toId, LOW } = require('../lib/util');

router.get('/', requireAuth, async (req, res) => {
  const classId = toId(req.query.class_id);
  const studentId = toId(req.query.student_id);
  const [classes, list] = await Promise.all([
    pool.query('SELECT id, name FROM classes ORDER BY name'),
    pool.query(
      `SELECT m.student_id, s.roll_no, s.name, c.name AS class_name,
              m.attendance_pct, m.marks, m.calculated_on
       FROM marks m
       JOIN students s ON s.id = m.student_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE ($1::int IS NULL OR s.class_id = $1)
         AND ($2::int IS NULL OR m.student_id = $2)
       ORDER BY c.name NULLS LAST, m.calculated_on DESC, LENGTH(s.roll_no), s.roll_no`, [classId, studentId]),
  ]);
  res.render('marks', {
    title: 'Marks', active: 'marks',
    classes: classes.rows, rows: list.rows,
    classId, studentId,
  });
});

router.post('/calculate', requireAuth, async (req, res) => {
  const classId = toId(req.body.class_id);
  const targetDate = req.body.as_of ? req.body.as_of : new Date().toISOString().slice(0, 10);

  if (classId) {
    await pool.query(
      `INSERT INTO marks (student_id, attendance_pct, marks, calculated_on)
       SELECT a.student_id,
              ROUND(100.0 * COUNT(*) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(*), 0), 1),
              ROUND(100.0 * COUNT(*) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(*), 0), 1),
              $3::date
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE s.class_id = $1
         AND a.date <= $3::date
       GROUP BY a.student_id
       ON CONFLICT (student_id, calculated_on) DO UPDATE SET
         attendance_pct = EXCLUDED.attendance_pct,
         marks = EXCLUDED.marks`,
      [classId, classId, targetDate]);
  } else {
    await pool.query(
      `INSERT INTO marks (student_id, attendance_pct, marks, calculated_on)
       SELECT a.student_id,
              ROUND(100.0 * COUNT(*) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(*), 0), 1),
              ROUND(100.0 * COUNT(*) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(*), 0), 1),
              $2::date
       FROM attendance a
       WHERE a.date <= $2::date
       GROUP BY a.student_id
       ON CONFLICT (student_id, calculated_on) DO UPDATE SET
         attendance_pct = EXCLUDED.attendance_pct,
         marks = EXCLUDED.marks`,
      [targetDate]);
  }

  req.flash('ok', 'Marks calculated for all students (attendance % = marks).');
  res.redirect('/marks' + (classId ? '?class_id=' + classId : ''));
});

router.get('/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const st = await pool.query(
    `SELECT s.id, s.roll_no, s.name, c.name AS class_name
     FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`, [id]);
  if (!st.rows[0]) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'That student could not be found.' });

  const [latest, history] = await Promise.all([
    pool.query(
      `SELECT attendance_pct, marks, calculated_on FROM marks
       WHERE student_id = $1 ORDER BY calculated_on DESC LIMIT 1`, [id]),
    pool.query(
      `SELECT attendance_pct, marks, calculated_on FROM marks
       WHERE student_id = $1 ORDER BY calculated_on DESC LIMIT 20`, [id]),
  ]);

  const current = latest.rows[0] || null;
  res.render('student-marks', {
    title: st.rows[0].name, active: 'marks',
    student: st.rows[0], current, history: history.rows,
  });
});

module.exports = router;
