-- Safe to run more than once. Run in the Neon SQL Editor.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher'
);
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  roll_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  class_id INT REFERENCES classes(id) ON DELETE SET NULL,
  user_id INT UNIQUE REFERENCES users(id) ON DELETE SET NULL
);
-- Added later: links an admin-registered student to the login they create themselves.
ALTER TABLE students ADD COLUMN IF NOT EXISTS user_id INT UNIQUE REFERENCES users(id) ON DELETE SET NULL;
-- Added later: a one-time code issued by the administrator so that a student can claim
-- their record. The roll number alone is not enough to create an account.
ALTER TABLE students ADD COLUMN IF NOT EXISTS registration_code_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS registration_code_expires TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (course_id, name)
);
CREATE TABLE IF NOT EXISTS student_section (
  student_id INT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  section_id INT NOT NULL REFERENCES sections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS parents (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  UNIQUE (student_id)
);
CREATE TABLE IF NOT EXISTS marks (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  calculated_on DATE NOT NULL DEFAULT CURRENT_DATE,
  attendance_pct NUMERIC(5,1) NOT NULL,
  marks NUMERIC(5,1) NOT NULL,
  UNIQUE (student_id, calculated_on)
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  parent_id INT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_on DATE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','both')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed'))
);
-- Added later: a message is queued with status 'pending' and no sent_on date.
-- sent_on is written only when a delivery provider confirms the message was sent,
-- so the column must be nullable.
ALTER TABLE messages ALTER COLUMN sent_on DROP NOT NULL;
-- Added later: delivery bookkeeping for worker/send-messages.js.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;
-- Added later: each channel is confirmed separately so a retry after a partial
-- failure never sends the same message twice.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sms_sent_at TIMESTAMPTZ;
-- Added later: transient failures are retried on an exponential backoff; NULL
-- means the message is due now.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late')),
  marked_by INT REFERENCES users(id),
  UNIQUE (student_id, date)
);

-- Speed-ups for reports and dashboard
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_marks_student ON marks(student_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
