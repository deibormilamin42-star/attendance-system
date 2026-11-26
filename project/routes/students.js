const router = require('express').Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { clean, toId, notFound } = require('../lib/util');
const registrationCode = require('../lib/registrationCode');

router.param('id', (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : next('route')));

const getClasses = () => pool.query('SELECT id, name FROM classes ORDER BY name');

function parseForm(body) {
  return {
    roll_no: clean(body.roll_no, 20),
    name: clean(body.name, 80),
    class_id: toId(body.class_id),
  };
}

router.get('/', async (req, res) => {
  const q = clean(req.query.q, 50);
  const classId = toId(req.query.class_id);
  const [list, classes] = await Promise.all([
    pool.query(
      `SELECT s.id, s.roll_no, s.name, c.name AS class_name,
              COUNT(a.id) AS total,
              ROUND(100.0 * COUNT(a.id) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(a.id), 0), 1)::float8 AS pct
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN attendance a ON a.student_id = s.id
       WHERE ($1::text = '' OR s.name ILIKE '%' || $1 || '%' OR s.roll_no ILIKE '%' || $1 || '%')
         AND ($2::int IS NULL OR s.class_id = $2)
       GROUP BY s.id, c.name
       ORDER BY c.name NULLS LAST, LENGTH(s.roll_no), s.roll_no
       LIMIT 500`, [q, classId]),
    getClasses(),
  ]);
  res.render('students', { title: 'Students', active: 'students', students: list.rows, classes: classes.rows, q, classId });
});

router.get('/new', requireAdmin, async (req, res) => {
  const classes = await getClasses();
  res.render('student-form', {
    title: 'Add student', active: 'students', isNew: true, error: null,
    student: { id: null, roll_no: '', name: '', class_id: toId(req.query.class_id) }, classes: classes.rows,
  });
});

router.post('/', requireAdmin, async (req, res) => {
  const s = parseForm(req.body);
  const classes = await getClasses();
  const show = (error) => res.status(400).render('student-form', {
    title: 'Add student', active: 'students', isNew: true, error, student: s, classes: classes.rows });

  if (!s.roll_no || !s.name) return show('Roll number and name are required.');
  try {
    await pool.query('INSERT INTO students (roll_no, name, class_id) VALUES ($1, $2, $3)', [s.roll_no, s.name, s.class_id]);
  } catch (e) {
    if (e.code === '23505') return show('That roll number already exists.');
    if (e.code === '23503') return show('The selected class no longer exists.');
    throw e;
  }
  req.flash('ok', `Student ${s.name} added.`);
  res.redirect('/students' + (s.class_id ? `?class_id=${s.class_id}` : ''));
});

router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const st = await pool.query(
    `SELECT s.id, s.roll_no, s.name, c.name AS class_name
     FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`, [id]);
  if (!st.rows[0]) return notFound(res, 'student');

  const [sum, hist] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'present') AS present,
              COUNT(*) FILTER (WHERE status = 'late') AS late,
              COUNT(*) FILTER (WHERE status = 'absent') AS absent,
              COUNT(*) AS total,
              ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('present','late')) / NULLIF(COUNT(*), 0), 1)::float8 AS pct
       FROM attendance WHERE student_id = $1`, [id]),
    pool.query('SELECT date, status FROM attendance WHERE student_id = $1 ORDER BY date DESC LIMIT 60', [id]),
  ]);
  res.render('student', { title: st.rows[0].name, active: 'students', student: st.rows[0], sum: sum.rows[0], history: hist.rows });
});

router.get('/:id/edit', requireAdmin, async (req, res) => {
  const [st, classes, courses, registration] = await Promise.all([
    pool.query(
      `SELECT id, roll_no, name, class_id, user_id,
              (registration_code_hash IS NOT NULL AND registration_code_expires > now()) AS code_active,
              to_char(registration_code_expires, 'DD Mon YYYY') AS code_expires
       FROM students WHERE id = $1`, [req.params.id]),
    getClasses(),
    pool.query('SELECT id, name, code FROM courses ORDER BY name'),
    pool.query(
      `SELECT sec.id AS section_id, sec.course_id
       FROM student_section ss
       JOIN sections sec ON sec.id = ss.section_id
       WHERE ss.student_id = $1`, [req.params.id]),
  ]);
  if (!st.rows[0]) return notFound(res, 'student');
  const currentSection = {
    courseId: registration.rows[0]?.course_id || null,
    selectedSectionId: registration.rows[0]?.section_id || null,
    sections: [],
  };
  if (currentSection.courseId) {
    const sections = await pool.query(
      'SELECT id, name FROM sections WHERE course_id = $1 ORDER BY name',
      [currentSection.courseId]);
    currentSection.sections = sections.rows;
  }
  res.render('student-form', {
    title: 'Edit student', active: 'students', isNew: false, error: null,
    student: st.rows[0], classes: classes.rows, courses: courses.rows, currentSection,
  });
});

// Issue (or re-issue) the one-time code a student uses to create their login.
router.post('/:id/registration-code', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const st = await pool.query('SELECT id, roll_no, user_id FROM students WHERE id = $1', [id]);
  if (!st.rows[0]) return notFound(res, 'student');
  if (st.rows[0].user_id) {
    req.flash('bad', 'That student already has a login linked to their record.');
    return res.redirect(`/students/${id}/edit`);
  }

  const code = registrationCode.generate();
  await pool.query(
    `UPDATE students SET registration_code_hash = $2,
            registration_code_expires = now() + ($3::text || ' days')::interval
     WHERE id = $1`,
    [id, await registrationCode.hash(code), String(registrationCode.DAYS)]);

  req.flash('ok', `Registration code for ${st.rows[0].roll_no}: ${code} ` +
    `(valid for ${registrationCode.DAYS} days). Give it to the student in person.`);
  res.redirect(`/students/${id}/edit`);
});

router.post('/:id/registration-code/delete', requireAdmin, async (req, res) => {
  await pool.query(
    'UPDATE students SET registration_code_hash = NULL, registration_code_expires = NULL WHERE id = $1',
    [req.params.id]);
  req.flash('ok', 'Registration code revoked.');
  res.redirect(`/students/${req.params.id}/edit`);
});

router.post('/:id/section', requireAdmin, async (req, res) => {
  const studentId = Number(req.params.id);
  const courseId = toId(req.body.course_id);
  const sectionId = toId(req.body.section_id);
  if (!courseId || !sectionId) {
    req.flash('bad', 'Please choose a course and section.');
    return res.redirect('/students/' + studentId + '/edit');
  }
  const registration = await pool.query(
    `INSERT INTO student_section (student_id, section_id)
     SELECT $1, id FROM sections WHERE id = $2 AND course_id = $3
     ON CONFLICT (student_id) DO UPDATE SET section_id = EXCLUDED.section_id
     RETURNING student_id`,
    [studentId, sectionId, courseId]);
  if (!registration.rowCount) {
    req.flash('bad', 'That section does not belong to the selected course.');
    return res.redirect('/students/' + studentId + '/edit');
  }
  req.flash('ok', 'Course and section registered.');
  res.redirect('/students/' + studentId + '/edit');
});

router.get('/:id/section/clear', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM student_section WHERE student_id = $1', [req.params.id]);
  req.flash('ok', 'Course and section registration removed.');
  res.redirect('/students/' + req.params.id + '/edit');
});

router.post('/:id', requireAdmin, async (req, res) => {
  const s = { ...parseForm(req.body), id: Number(req.params.id) };
  const classes = await getClasses();
  const show = (error) => res.status(400).render('student-form', {
    title: 'Edit student', active: 'students', isNew: false, error, student: s, classes: classes.rows });

  if (!s.roll_no || !s.name) return show('Roll number and name are required.');
  try {
    await pool.query('UPDATE students SET roll_no = $1, name = $2, class_id = $3 WHERE id = $4', [s.roll_no, s.name, s.class_id, s.id]);
  } catch (e) {
    if (e.code === '23505') return show('That roll number already exists.');
    if (e.code === '23503') return show('The selected class no longer exists.');
    throw e;
  }
  req.flash('ok', 'Student updated.');
  res.redirect('/students');
});

router.post('/:id/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
  req.flash('ok', 'Student and their attendance records were deleted.');
  res.redirect('/students');
});

module.exports = router;
