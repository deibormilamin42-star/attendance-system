const pool = require('./db');
pool.query('SELECT NOW()')
  .then(r => { console.log('Connected!', r.rows[0]); pool.end(); })
  .catch(e => { console.error('Failed:', e.message); pool.end(); });