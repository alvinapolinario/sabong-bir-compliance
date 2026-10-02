'use strict';
process.env.TZ = 'Asia/Manila';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const config = require('./config');
const db = require('./db');
const { csrf, ROLE_LABEL } = require('./auth');
const { peso } = require('./money');
const reports = require('./reports');
const { ready } = require('./crypto');

const app = express();
app.disable('x-powered-by');
// nginx on the same machine. In Docker nginx arrives from the bridge gateway: TRUST_PROXY=loopback,uniquelocal
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'form-action': ["'self'"] },
  },
  hsts: config.appUrl.startsWith('https://') ? { maxAge: 31536000 } : false,
}));
app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.use(session({
  name: 'bir.sid',
  secret: config.sessionSecret(),
  store: new MySQLStore({ createDatabaseTable: true, clearExpired: true, checkExpirationInterval: 15 * 60 * 1000 }, db.pool),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appUrl.startsWith('https://'),
    maxAge: config.sessionHours * 60 * 60 * 1000,
  },
}));

app.use(csrf);
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.arena = config.arenaName;
  res.locals.peso = peso;
  res.locals.rateText = reports.rateText;
  res.locals.formulaText = reports.formulaText;
  res.locals.taxableBets = reports.taxableBets;
  res.locals.ROLE_LABEL = ROLE_LABEL;
  res.locals.path = req.path;
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(require('./routes/main'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'This page does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const ref = Date.now().toString(36).toUpperCase();
  console.error(`[${ref}]`, err);
  res.status(500).render('error', { title: 'Something went wrong', message: `The request could not be completed. Reference: ${ref}` });
});

(async () => {
  await ready();
  await db.query('SELECT 1');
  app.listen(config.port, config.host, () => console.log(`BIR Compliance System listening on http://${config.host}:${config.port}`));
})().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
