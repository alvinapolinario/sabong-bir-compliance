'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { audit } = require('./audit');
const { nowLocal } = require('./util');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Compared against for unknown usernames, so response time does not reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

const ROLE_LABEL = { admin: 'Administrator', accounting: 'Accounting', treasury: 'Treasury Office' };

/** Blocks the route unless the signed-in user has one of the roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (roles.length && !roles.includes(u.role)) {
      audit(req, 'access_denied', 'route', req.originalUrl).catch(() => {});
      return res.status(403).render('error', { title: 'Not allowed', message: 'Your account does not have access to this page.' });
    }
    next();
  };
}

function csrfValid(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf || '');
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const csrfFail = (res) => res.status(403).render('error', { title: 'Form expired', message: 'This form has expired. Go back, reload the page and try again.' });

/**
 * Per-session CSRF token, required on every POST. File uploads (multipart)
 * are checked by csrfAfterUpload once the form has been parsed.
 */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST' && !req.is('multipart/form-data') && !csrfValid(req)) return csrfFail(res);
  next();
}

function csrfAfterUpload(req, res, next) {
  return csrfValid(req) ? next() : csrfFail(res);
}

async function login(req, username, password) {
  const u = await db.one('SELECT * FROM users WHERE username = ?', [String(username || '').trim()]);
  const now = nowLocal();
  if (!u || !u.is_active) {
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
    await audit(req, 'login_failed', 'user', username, { reason: u ? 'inactive' : 'unknown user' });
    return { ok: false, message: 'Incorrect username or password.' };
  }
  if (u.locked_until && u.locked_until > now) {
    await audit(req, 'login_blocked', 'user', u.id, { locked_until: u.locked_until });
    return { ok: false, message: `Account temporarily locked after repeated failed sign-ins. Try again after ${u.locked_until.slice(11, 16)}.` };
  }
  if (!(await bcrypt.compare(String(password || ''), u.password_hash))) {
    const fails = u.failed_attempts + 1;
    const lock = fails >= MAX_FAILED;
    await db.query('UPDATE users SET failed_attempts = ?, locked_until = IF(?, NOW() + INTERVAL ? MINUTE, NULL) WHERE id = ?',
      [lock ? 0 : fails, lock, LOCK_MINUTES, u.id]);
    await audit(req, lock ? 'account_locked' : 'login_failed', 'user', u.id, { attempts: fails });
    return { ok: false, message: lock ? `Too many failed sign-ins. The account is locked for ${LOCK_MINUTES} minutes.` : 'Incorrect username or password.' };
  }
  await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?', [u.id]);
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.user = { id: u.id, username: u.username, fullName: u.full_name, role: u.role };
  await audit(req, 'login', 'user', u.id);
  return { ok: true };
}

const hashPassword = (pw) => bcrypt.hash(pw, 12);

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

module.exports = { requireRole, csrf, csrfAfterUpload, login, hashPassword, passwordProblem, ROLE_LABEL };
