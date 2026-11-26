const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { toId, notFound, clean } = require('../lib/util');
const dates = require('../lib/dates');
const mail = require('../lib/email');

if (mail.isConfigured()) console.log('[mail] E-mail delivery is configured.');
else console.warn(`[mail] E-mail delivery is OFF. Missing: ${mail.missingConfig()}`);

// Send immediately and record the result. A logging failure must not undo a
// delivery that the provider already accepted.
async function sendNow({ studentId, parentId, to, subject, body }) {
  let ok = false;
  let error = '';
  try {
    await mail.sendEmail({ to, subject, text: body });
    ok = true;
  } catch (e) {
    error = e.message;
    console.error(`[mail] send to ${to || '(no address)'} failed:`, e.message);
  }
  try {
    await pool.query(
      `INSERT INTO messages (student_id, parent_id, subject, body, channel, status,
                             attempts, last_error, sent_on, email_sent_at)
       VALUES ($1, $2, $3, $4, 'email', $5::text, 1, $6, $7,
               CASE WHEN $5::text = 'sent' THEN now() END)`,
      [studentId, parentId, subject, body, ok ? 'sent' : 'failed',
        ok ? null : error.slice(0, 500), ok ? dates.today() : null]);
  } catch (e) {
    console.error('[mail] could not record message:', e.message);
  }
  return { ok, error };
}

// Only numeric ids match these routes, so /parents/notify falls through to its own handler.
router.param('id', (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : next('route')));

// List students with parent info + message log
router.get('/', requireAuth, async (req, res) => {
  const classId = toId(req.query.class_id);
  const [classes, rows] = await Promise.all([
    pool.query('SELECT id, name FROM classes ORDER BY name'),
    pool.query(
      `SELECT s.id, s.roll_no, s.name, c.name AS class_name,
              p.id AS parent_id, p.name AS parent_name, p.email, p.phone,
              (SELECT COUNT(*) FROM messages WHERE student_id = s.id AND status = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM messages WHERE student_id = s.id AND status = 'failed') AS failed_count,
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
    providers: { email: mail.isConfigured() },
  });
});

// Message log: what the worker delivered, what is still queued, what failed and why
router.get('/messages', requireAdmin, async (req, res) => {
  const requested = String(req.query.status || 'failed');
  const status = ['failed', 'pending', 'sent', 'all'].includes(requested) ? requested : 'failed';
  const { rows } = await pool.query(
    `SELECT m.id, m.subject, m.channel, m.status, m.attempts, m.last_error, m.sent_on,
            to_char(m.next_attempt_at, 'DD Mon HH24:MI') AS next_attempt,
            to_char(m.email_sent_at, 'DD Mon HH24:MI') AS email_sent,
            to_char(m.sms_sent_at, 'DD Mon HH24:MI') AS sms_sent,
            s.roll_no, s.name AS student_name,
            p.name AS parent_name, p.email, p.phone
       FROM messages m
       JOIN students s ON s.id = m.student_id
       LEFT JOIN parents p ON p.id = m.parent_id
      WHERE ($1::text IS NULL OR m.status = $1)
      ORDER BY m.id DESC
      LIMIT 200`, [status === 'all' ? null : status]);
  res.render('message-log', {
    title: 'Message log', active: 'parents', rows: rows.rows, status,
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
    providers: { email: mail.isConfigured() },
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
      providers: { email: mail.isConfigured() },
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
        providers: { email: mail.isConfigured() },
        error: 'The student record no longer exists.',
      });
    }
    throw e;
  }

  req.flash('ok', 'Parent / guardian saved.');
  res.redirect('/parents');
});

// Send a message to a parent, immediately
router.post('/:id/message', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const st = await pool.query('SELECT id, roll_no, name FROM students WHERE id = $1', [id]);
  if (!st.rows[0]) return notFound(res, 'student');

  if (!req.body.subject || !req.body.body) {
    req.flash('bad', 'Subject and message are required.');
    return res.redirect('/parents');
  }

  const parent = await pool.query('SELECT id, email FROM parents WHERE student_id = $1', [id]);
  if (!parent.rows[0]) {
    req.flash('bad', 'No parent / guardian registered for this student.');
    return res.redirect('/parents');
  }

  const result = await sendNow({
    studentId: id,
    parentId: parent.rows[0].id,
    to: parent.rows[0].email,
    subject: clean(req.body.subject, 120),
    body: clean(req.body.body, 2000),
  });

  if (result.ok) req.flash('ok', 'Message sent.');
  else req.flash('bad', `Message failed: ${result.error}`);
  res.redirect('/parents');
});

// Mass notify: e-mail every parent whose child's latest marks are below the threshold
router.post('/notify', requireAdmin, async (req, res) => {
  const lowThreshold = Number(process.env.LOW_ATTENDANCE || 75);

  // attendance_pct and marks must be selected here, or the message text says "undefined%".
  const { rows } = await pool.query(
    `SELECT s.id AS student_id, s.roll_no, s.name, c.name AS class_name,
            p.id AS parent_id, p.name AS parent_name, p.email,
            m.attendance_pct, m.marks
     FROM students s
     JOIN parents p ON p.student_id = s.id
     JOIN marks m ON m.student_id = s.id
     LEFT JOIN classes c ON c.id = s.class_id
     WHERE m.id = (
       SELECT id FROM marks m2 WHERE m2.student_id = s.id ORDER BY calculated_on DESC LIMIT 1
     ) AND (m.attendance_pct < $1 OR m.marks < $1)
       AND p.email IS NOT NULL
     ORDER BY s.roll_no`, [lowThreshold]);

  let sent = 0;
  let failed = 0;
  let firstError = '';
  for (const r of rows) {
    const subject = `Attendance alert: ${r.roll_no} ${r.name}`;
    const body = `Dear ${r.parent_name},\n\nThis is to inform you that ${r.name} (Roll ${r.roll_no}${r.class_name ? ', ' + r.class_name : ''}) currently has an attendance percentage of ${r.attendance_pct}% and marks of ${r.marks}%. At least one is below the required ${lowThreshold}% threshold.\n\nPlease ensure regular attendance and academic progress.\n\nRegards,\nSchool Administration`;

    const result = await sendNow({
      studentId: r.student_id, parentId: r.parent_id, to: r.email, subject, body,
    });
    if (result.ok) sent++;
    else { failed++; firstError = firstError || result.error; }
  }

  if (!rows.length) req.flash('ok', 'No parents needed notification.');
  else if (failed) req.flash('bad', `${sent} sent, ${failed} failed. First error: ${firstError}`);
  else req.flash('ok', `${sent} notification${sent > 1 ? 's' : ''} sent.`);
  res.redirect('/parents');
});

module.exports = router;
