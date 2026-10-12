const bcrypt = require('bcryptjs');
const pool = require('../db');

(async () => {
  const hash = await bcrypt.hash('Admin@12345', 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin') ON CONFLICT (email) DO NOTHING`,
    ['Administrator', 'admin@college.edu', hash]
  );
  console.log('Admin ready');
  await pool.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });