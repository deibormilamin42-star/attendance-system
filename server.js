require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const pool = require('./db');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));
app.use('/', require('./routes/auth'));
app.get('/dashboard', requireAuth, (req, res) => res.render('dashboard', { title: 'Dashboard' }));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));