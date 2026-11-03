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

## One-time database setup
1. Neon SQL Editor: run `sql/schema.sql` (safe to re-run; adds indexes).
2. `node sql/seed.js` creates the first admin (admin@college.edu / Admin@12345). Change the password under "My account".
3. Optional: `node sql/seed-student.js` creates a student user for testing the student login page (student@college.edu / Student@12345).
4. Optional demo data for screenshots: `node sql/demo.js` (remove later with `node sql/demo.js --clear`).

## Messages / parent notifications
The app stores messages and marks them "sent" when queued. To actually send email/SMS, connect a provider (e.g. Resend, SendGrid, Twilio) and call the messages table from a worker. The current "Notify parents" button writes real messages with status "sent" so the UI reflects the intent; wiring the external provider is the next step.

## Roles
- Admin: everything, including classes, students, users, courses & sections, parents, marks, and messages.
- Teacher: dashboard, mark attendance, reports, CSV export, view classes and students.
- Student: own dashboard — attendance %, marks, course/section registration, parent on file.

## New features added
- Courses & sections: admin creates courses (code + name) and sections; students are registered to a course+section from the student edit page.
- Marks: admin triggers mark calculation on the Marks page. Marks are auto-derived from attendance percentage up to a chosen date (marks = attendance %). Each student's latest marks show on their student page and in the student dashboard.
- Parents & messages: admin sets a parent/guardian name, email and phone per student. Admin can send individual messages and use "Notify parents" to automatically message every parent whose student's latest marks are below the LOW_ATTENDANCE threshold. Messages are stored in the messages table with status sent/pending/failed.
- Student login: separate `/student/login` page and student dashboard. Students log in with their own email/password (role = 'student').
