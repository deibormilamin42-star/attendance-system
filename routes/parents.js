const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { toId, notFound, clean } = require('../lib/util');

// List students with parent info + message log
router.get('/', requireAuth, async (req, res) => {
  const classId = toId(req.query.class_id);
  const [classes, rows] = await Promise.all([
    pool.query('SELECT id, name FROM classes ORDER BY name'),
    pool.query(
      `SELECT s.id, s.roll_no, s.name, c.name AS class_name,
              p.id AS parent_id, p.name AS parent_name, p.email, p.phone,
              (SELECT COUNT(*) FROM messages WHERE student_id = s.id AND status = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM messages WHERE student_id = s.id) AS msg_count
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN parents p ON p.student_id = s.id
       WHERE ($1::int IS NULL OR s.class_id = $1)
       ORDER BY c.name NULLS LAST, s.roll_no`, [classId]),
  ]);
  res.render('parents', {
    title: 'Parents & messages', active: 'parents',
    classes: classes.rows, rows: rows.rows, classId,
  });
});

// Edit / add parent for a student
router.get('/:id/edit', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const st = await pool.query('SELECT id, roll_no, name FROM students WHERE id = $1', [id]);
  if (!st.rows[0]) return notFound(res, 'student');
  const p = await pool.query('SELECT id, name, email, phone FROM parents WHERE student_id = $1', [id]);
  res.render('parent-form', {
    title: 'Parent / guardian', active: 'parents',
    student: st.rows[0], parent: p.rows[0] || { id: null, name: '', email: '', phone: '' },
    error: null,
  });
});

router.post('/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const st = await pool.query('SELECT id, roll_no, name FROM students WHERE id = $1', [id]);
  if (!st.rows[0]) return notFound(res, 'student');

  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 120);
  const phone = clean(req.body.phone, 30);

  if (!name) {
    return res.status(400).render('parent-form', {
      title: 'Parent / guardian', active: 'parents',
      student: st.rows[0], parent: { id: null, name: '', email: '', phone: '' },
      error: 'Parent name is required.',
    });
  }

  try {
    await pool.query(
      `INSERT INTO parents (student_id, name, email, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (student_id) DO UPDATE SET name = $2, email = $3, phone = $4`,
      [id, name, email || null, phone || null]);
  } catch (e) {
    if (e.code === '23503') {
      return res.status(400).render('parent-form', {
        title: 'Parent / guardian', active: 'parents',
        student: st.rows[0], parent: { id: null, name, email, phone },
        error: 'The student record no longer exists.',
      });
    }
    throw e;
  }

  req.flash('ok', 'Parent / guardian saved.');
  res.redirect('/parents');
});

// Send a message to a parent
router.post('/:id/message', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const st = await pool.query('SELECT id, roll_no, name FROM students WHERE id = $1', [id]);
  if (!st.rows[0]) return notFound(res, 'student');

  if (!req.body.subject || !req.body.body) {
    req.flash('bad', 'Subject and message are required.');
    return res.redirect('/parents');
  }

  const parent = await pool.query('SELECT id FROM parents WHERE student_id = $1', [id]);
  if (!parent.rows[0]) {
    req.flash('bad', 'No parent / guardian registered for this student.');
    return res.redirect('/parents');
  }

  const subject = clean(req.body.subject, 120);
  const body = clean(req.body.body, 2000);
  const channel = (req.body.channel || 'email') === 'both' ? 'both' : (req.body.channel || 'email');

  await pool.query(
    `INSERT INTO messages (student_id, parent_id, subject, body, channel)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, parent.rows[0].id, subject, body, channel]);

  // In a real deployment this would call an email/SMS provider.
  // For now we mark them sent so the UI reflects the intent.
  await pool.query(
    `UPDATE messages SET status = 'sent' WHERE student_id = $1 AND parent_id = $2 AND subject = $3 AND body = $4`,
    [id, parent.rows[0].id, subject, body]);

  req.flash('ok', 'Message queued and marked sent.');
  res.redirect('/parents');
});

// Mass notify: send attendance/marks alerts to all parents with pending low-attendance students
router.post('/notify', requireAdmin, async (req, res) => {
  const lowThreshold = Number(process.env.LOW_ATTENDANCE || 75);
  const today = new Date().toISOString().slice(0, 10);

  // Find students whose latest marks are below the threshold and have a parent with email or phone
  const { rows } = await pool.query(
    `SELECT s.id AS student_id, s.roll_no, s.name, c.name AS class_name,
            p.id AS parent_id, p.name AS parent_name, p.email, p.phone
     FROM students s
     JOIN parents p ON p.student_id = s.id
     JOIN marks m ON m.student_id = s.id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE m.id = (
       SELECT id FROM marks m2 WHERE m2.student_id = s.id ORDER BY calculated_on DESC LIMIT 1
     ) AND (m.attendance_pct < $1 OR m.marks < $1)
       AND (p.email IS NOT NULL OR p.phone IS NOT NULL)
     ORDER BY s.roll_no`, [lowThreshold]);

  let sent = 0;
  for (const r of rows) {
    const subject = `Attendance alert: ${r.roll_no} ${r.name}`;
    const body = `Dear ${r.parent_name},\n\nThis is to inform you that ${r.name} (Roll ${r.roll_no}${r.class_name ? ', ' + r.class_name : ''}) currently has an attendance percentage of ${r.attendance_pct}% which is below the required ${lowThreshold}% threshold.\n\nPlease ensure regular attendance.\n\nRegards,\nSchool Administration`;
    await pool.query(
      `INSERT INTO messages (student_id, parent_id, subject, body, channel, sent_on, status)
       VALUES ($1, $2, $3, $4, 'both', $5::date, 'sent')`,
      [r.student_id, r.parent_id, subject, body, today]);
    sent++;
  }

  req.flash('ok', `Notification ${sent > 0 ? 'sent to ' + sent + ' parent' + (sent > 1 ? 's' : '') : 'no parents needed notification'}.`);
  res.redirect('/parents');
});

module.exports = router;
