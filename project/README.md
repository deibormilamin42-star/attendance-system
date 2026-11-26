# Attendly - Student Attendance Management System

Node.js + Express + EJS, PostgreSQL on Neon, hosted on Render.

## Run locally
    npm install
    npm run dev          # http://localhost:3000

## Environment variables (.env locally, Environment tab on Render)
| Name | Required | Notes |
|---|---|---|
| DATABASE_URL | yes | Neon connection string |
| SESSION_SECRET | yes | long random text |
| NODE_ENV | on Render | production |
| APP_TZ | optional | default Asia/Kolkata (decides what "today" means) |
| LOW_ATTENDANCE | optional | default 75 (% threshold for warnings) |
| BREVO_API_KEY | for e-mail | API key from brevo.com; without it e-mail messages stay pending |
| MAIL_FROM | for e-mail | verified sender, e.g. `Attendly <alerts@yourdomain>` |
| MAIL_INTERVAL_MS | optional | worker poll interval, default 60000 |
| MAIL_BATCH | optional | messages per pass, default 20 |
| MAIL_MAX_ATTEMPTS | optional | attempts before a message is marked failed, default 5 |
| MAIL_BACKOFF_BASE_MS | optional | first retry delay, doubled per attempt, default 60000 (1 minute) |
| MAIL_BACKOFF_MAX_MS | optional | cap on the retry delay, default 3600000 (1 hour) |

## One-time database setup
1. Neon SQL Editor: run `sql/schema.sql` (safe to re-run; adds indexes).
2. `node sql/seed.js` creates the first admin (admin@college.edu / Admin@12345). Change the password under "My account".
3. Optional: `node sql/seed-student.js` creates a student user and links it to an existing student record for testing the student login page (student@college.edu / Student@12345). Set `STUDENT_ROLL_NO` to choose which unlinked student it attaches to.
4. Optional demo data for screenshots: `node sql/demo.js` (remove later with `node sql/demo.js --clear`).
5. Start the message worker in a second process (`npm run worker`) or as a Render background worker with the same environment variables. On Render, `npm run worker:once` also works as a cron job.

## Messages / parent notifications
"Send message" and "Notify parents" send e-mail immediately via Brevo when the form is submitted, and record the result (sent/failed) right away. No separate background worker is required.

Delivery happens in `worker/send-messages.js` (the `deliver` and `record` functions), called directly from the route handler. A message becomes "sent" when Brevo accepts it; `sent_on` is then set from `dates.today()` (APP_TZ). A permanent provider error sets "failed" and stores the reason in `last_error`.

Transient errors (timeouts, 429, 5xx) leave the message pending with an exponential backoff: the first retry is `MAIL_BACKOFF_BASE_MS` later, each further retry doubles that, capped at `MAIL_BACKOFF_MAX_MS`. With the defaults that is 1, 2, 4 and 8 minutes before the fifth failure marks the message failed. The wait is stored per message in `next_attempt_at`, so a restart does not reset it.

To retry pending messages without a background worker, run:

    npm run worker:once     # a single pass over pending messages

Admins can see what happened on the **Message log** page (`/parents/messages`, linked from Parents & messages): filter by failed, pending, sent or all, with each student, channel, attempt count, per-channel delivery time, the next retry due, and the provider error for anything that failed.

E-mail goes through Brevo (`lib/email.js`, `BREVO_API_KEY` + `MAIL_FROM`). Store parent phone numbers in E.164 form (`+919876543210`) for the contact display; SMS delivery is no longer offered from the admin page.

`email_sent_at` is stamped as soon as e-mail is accepted, so a retry never sends the same message twice. A message is marked "sent" when e-mail is accepted; if e-mail fails permanently, the message is marked "failed" and `last_error` says why.

The worker only claims pending e-mail messages when BREVO_API_KEY and MAIL_FROM are set; otherwise messages stay pending.

## Tests
    npm test

Uses Node's built-in test runner, so there is nothing to install. The suite covers the date, identifier, registration-code and rate-limit helpers; the e-mail adapter against a local stub HTTP server; the worker's delivery handling and bookkeeping (with a stubbed `pool.query`); and HTTP smoke tests that start the real server and check the health endpoint, login page and CSRF token, the auth redirect, a rejected POST, the 404 page, security headers and a static asset.

Not covered: anything that needs PostgreSQL (attendance saving, report totals, CSV export, the schema) and real delivery through Brevo.

## Roles
- Admin: everything, including classes, students, users, courses & sections, parents, marks, and messages.
- Teacher: dashboard, mark attendance, reports, CSV export, view classes and students.
- Student: own dashboard — attendance %, marks, course/section registration, parent on file.

## New features added
- Courses & sections: admin creates courses (code + name) and sections; students are registered to a course+section from the student edit page.
- Marks: admin triggers mark calculation on the Marks page. Marks are auto-derived from attendance percentage up to a chosen date (marks = attendance %). Each student's latest marks show on their student page and in the student dashboard.
- Parents & messages: admin sets a parent/guardian name, email and phone per student. Admin can send individual messages and use "Notify parents" to automatically message every parent whose student's latest marks are below the LOW_ATTENDANCE threshold. Messages are stored in the messages table with status pending/sent/failed and delivered by the worker over e-mail; the parents page shows how many are pending or failed per student.
- Student login: separate `/student/login` page and student dashboard. Students log in with their own email/password (role = 'student').

## Student self-registration
Students create their own login at `/student/register`, but a roll number alone is not enough. An administrator first issues a one-time code from the student's edit page (Students -> Edit -> Student login -> Generate registration code). Only a bcrypt hash of the code is stored; the code is shown once and is valid for 14 days. Registration is throttled on wrong codes, and the record is claimed in a transaction so a code cannot be consumed without creating the account.
