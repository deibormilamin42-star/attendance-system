const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { toId, notFound, clean } = require('../lib/util');
const mail = require('../lib/email');
const { deliver, record } = require('../worker/send-messages');

const CHANNELS = new Set(['email']);
// A message can only be delivered when e-mail is configured.
const channelReady = (channel) => channel === 'email' && mail.isConfigured();
// The channel this deployment can actually deliver: e-mail when configured.
const defaultChannel = () => mail.isConfigured() ? 'email' : null;

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
  const channel = defaultChannel();

  // Stored as pending; then we attempt delivery immediately so no background
  // worker is required for e-mail to actually reach the parent.
  const insert = await pool.query(
    `INSERT INTO messages (student_id, parent_id, subject, body, channel, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [id, parent.rows[0].id, subject, body, channel]);
  const messageId = insert.rows[0].id;

  const parentRow = await pool.query(
    'SELECT email FROM parents WHERE id = $1', [parent.rows[0].id]);

  const row = {
    id: messageId,
    channel,
    subject,
    body,
    parent_email: parentRow.rows[0]?.email || null,
    email_sent_at: null,
    attempts: 0,
  };

  const delivery = await deliver(row);
  await record(row, delivery);

  req.flash('ok', delivery.ok
    ? 'Message sent.'
    : `Message failed: ${delivery.error}`);
  res.redirect('/parents');
});

// Mass notify: send attendance/marks alerts to all parents with pending low-attendance students
router.post('/notify', requireAdmin, async (req, res) => {
  const lowThreshold = Number(process.env.LOW_ATTENDANCE || 75);

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

  const channel = defaultChannel();
  let queued = 0;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const subject = `Attendance alert: ${r.roll_no} ${r.name}`;
    const body = `Dear ${r.parent_name},\n\nThis is to inform you that ${r.name} (Roll ${r.roll_no}${r.class_name ? ', ' + r.class_name : ''}) currently has an attendance percentage of ${r.attendance_pct}% which is below the required ${lowThreshold}% threshold.\n\nPlease ensure regular attendance.\n\nRegards,\nSchool Administration`;

    const insert = await pool.query(
      `INSERT INTO messages (student_id, parent_id, subject, body, channel, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [r.student_id, r.parent_id, subject, body, channel]);
    const messageId = insert.rows[0].id;

    const row = {
      id: messageId,
      channel,
      subject,
      body,
      parent_email: r.email || null,
      email_sent_at: null,
      attempts: 0,
    };

    const delivery = await deliver(row);
    await record(row, delivery);
    queued++;
    if (delivery.ok) sent++; else failed++;
  }

  req.flash('ok', queued > 0
    ? `${queued} notification${queued > 1 ? 's' : ''} processed: ${sent} sent, ${failed} failed.`
    : 'No parents needed notification.');
  res.redirect('/parents');
});

module.exports = router;
