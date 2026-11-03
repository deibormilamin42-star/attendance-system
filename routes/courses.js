const router = require('express').Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { clean, toId, notFound } = require('../lib/util');

router.param('id', (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : next('route')));

function parseCourse(body) {
  return {
    name: clean(body.name, 80),
    code: clean(body.code, 20).toUpperCase(),
  };
}

function parseSection(body) {
  return {
    course_id: toId(body.course_id),
    name: clean(body.name, 40),
  };
}

router.get('/', requireAdmin, async (req, res) => {
  const [courses, classes] = await Promise.all([
    pool.query('SELECT c.id, c.name, c.code FROM courses c ORDER BY c.name'),
    pool.query('SELECT id, name FROM classes ORDER BY name'),
  ]);
  const sections = await pool.query('SELECT s.id, s.name, s.course_id FROM sections s ORDER BY s.course_id, s.name');
  const grouped = new Map();
  courses.rows.forEach((c) => grouped.set(c.id, { ...c, sections: [], section_count: 0 }));
  sections.rows.forEach((s) => {
    const g = grouped.get(s.course_id);
    if (g) { g.sections.push({ id: s.id, name: s.name }); g.section_count++; }
  });
  res.render('courses', {
    title: 'Courses & sections',
    active: 'courses',
    courses: grouped.values(),
    classes: classes.rows,
    error: null,
    course: { id: null, name: '', code: '' },
    section: { id: null, course_id: toId(req.query.course_id), name: '' },
  });
});

router.post('/', requireAdmin, async (req, res) => {
  const c = parseCourse(req.body);
  const courses = await pool.query('SELECT id, name, code FROM courses ORDER BY name');
  const show = (error) => res.status(400).render('courses', {
    title: 'Courses & sections', active: 'courses', error, courses: courses.rows,
    classes, course: c, section: { id: null, course_id: null, name: '' },
  });
  if (!c.name || !c.code) return show('Course name and code are required.');
  try {
    await pool.query('INSERT INTO courses (name, code) VALUES ($1, $2)', [c.name, c.code]);
    req.flash('ok', `Course "${c.code}" added.`);
  } catch (e) {
    if (e.code === '23505') return show('A course with that code already exists.');
    throw e;
  }
  res.redirect('/courses');
});

router.post('/sections', requireAdmin, async (req, res) => {
  const s = parseSection(req.body);
  const courses = await pool.query('SELECT id, name, code FROM courses ORDER BY name');
  const show = (error) => res.status(400).render('courses', {
    title: 'Courses & sections', active: 'courses', error, courses: courses.rows,
    classes, course: { id: null, name: '', code: '' },
    section: s,
  });
  if (!s.course_id || !s.name) return show('Please choose a course and enter a section name.');
  try {
    await pool.query('INSERT INTO sections (course_id, name) VALUES ($1, $2)', [s.course_id, s.name]);
    req.flash('ok', 'Section added.');
  } catch (e) {
    if (e.code === '23505') return show('That section already exists for this course.');
    if (e.code === '23503') return show('The selected course no longer exists.');
    throw e;
  }
  res.redirect('/courses');
});

router.post('/sections/:id/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM sections WHERE id = $1', [req.params.id]);
  req.flash('ok', 'Section deleted.');
  res.redirect('/courses');
});

router.get('/:id', requireAdmin, async (req, res) => {
  const [course, sections] = await Promise.all([
    pool.query('SELECT id, name, code FROM courses WHERE id = $1', [req.params.id]),
    pool.query('SELECT s.id, s.name, COUNT(ss.student_id) AS student_count FROM sections s LEFT JOIN student_section ss ON ss.section_id = s.id WHERE s.course_id = $1 GROUP BY s.id ORDER BY s.name', [req.params.id]),
  ]);
  if (!course.rows[0]) return notFound(res, 'course');
  res.render('course-detail', {
    title: course.rows[0].code, active: 'courses',
    course: course.rows[0], sections: sections.rows,
  });
});

module.exports = router;
