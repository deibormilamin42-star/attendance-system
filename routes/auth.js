const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).render('login', { title: 'Login', error: 'Invalid email or password' });
  }
  req.session.regenerate(() => {
    req.session.user = { id: u.id, name: u.name, role: u.role };
    res.redirect('/dashboard');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;