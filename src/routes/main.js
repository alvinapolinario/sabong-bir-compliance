'use strict';
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { audit } = require('../audit');
const { requireRole, csrfAfterUpload, login, hashPassword, passwordProblem } = require('../auth');
const { ingestUpload } = require('../ingest');
const reports = require('../reports');
const { cents, fmt, rateFromPercents } = require('../money');

const router = express.Router();
const ALL = ['admin', 'accounting', 'treasury'];
const UPLOADERS = ['admin', 'accounting'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { error: 'Too many sign-in attempts from this device. Wait 15 minutes.', username: '' }) });

// ------------------------------------------------------------------ sign-in
router.get('/login', (req, res) => (req.session.user ? res.redirect('/') : res.render('login', { error: null, username: '' })));

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const r = await login(req, req.body.username, req.body.password);
    if (!r.ok) return res.status(401).render('login', { error: r.message, username: String(req.body.username || '').slice(0, 60) });
    res.redirect('/');
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  await audit(req, 'logout').catch(() => {});
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------- dashboard
router.get('/', requireRole(...ALL), async (req, res, next) => {
  try {
    const servers = await db.query(`SELECT s.server_id, s.name, s.status, s.kind,
        (SELECT MAX(sequence_no) FROM packages p WHERE p.server_id = s.server_id) AS last_seq,
        (SELECT MAX(received_at) FROM packages p WHERE p.server_id = s.server_id) AS last_received
      FROM betting_servers s ORDER BY s.server_id`);
    const recent = await db.query(`SELECT r.*, p.sequence_no, p.seal_code, p.received_at FROM event_reports r
      JOIN packages p ON p.id = r.package_id ORDER BY p.received_at DESC LIMIT 10`);
    const rejected = await db.query(`SELECT * FROM upload_attempts WHERE result = 'rejected' AND uploaded_at >= NOW() - INTERVAL 30 DAY ORDER BY id DESC LIMIT 5`);
    const month = new Date().toISOString().slice(0, 7);
    const summary = await reports.monthly(month);
    res.render('dashboard', { servers, recent, rejected, summary });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- upload
router.get('/upload', requireRole(...UPLOADERS), (req, res) => res.render('upload', { outcome: null }));

router.post('/upload', requireRole(...UPLOADERS), (req, res, next) => {
  upload.single('package')(req, res, (err) => {
    if (err) return res.status(400).render('upload', { outcome: { result: 'rejected', checks: [{ name: 'upload', passed: false, detail: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload failed.' }] } });
    next();
  });
}, csrfAfterUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).render('upload', { outcome: { result: 'rejected', checks: [{ name: 'file', passed: false, detail: 'Choose a .pkg.enc file.' }] } });
    const outcome = await ingestUpload({ buffer: req.file.buffer, fileName: req.file.originalname, userId: req.session.user.id, ip: req.ip });
    await audit(req, `package_${outcome.result}`, 'package', outcome.packageId || null, {
      file: req.file.originalname, seal: outcome.sealCode || null, failed: outcome.checks.filter((c) => !c.passed).map((c) => c.name),
    });
    res.status(outcome.result === 'rejected' ? 422 : 200).render('upload', { outcome });
  } catch (e) { next(e); }
});

router.get('/uploads', requireRole(...ALL), async (req, res, next) => {
  try {
    const rows = await db.query(`SELECT a.*, u.username FROM upload_attempts a LEFT JOIN users u ON u.id = a.uploaded_by ORDER BY a.id DESC LIMIT 200`);
    res.render('uploads', { rows });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- events
router.get('/events', requireRole(...ALL), async (req, res, next) => {
  try {
    const rows = await db.query(`SELECT r.*, p.sequence_no, p.seal_code, p.received_at, p.ack_code FROM event_reports r
      JOIN packages p ON p.id = r.package_id ORDER BY r.event_date DESC, p.sequence_no DESC`);
    res.render('events', { rows });
  } catch (e) { next(e); }
});

router.get('/events/:id(\\d+)', requireRole(...ALL), async (req, res, next) => {
  try {
    const pkg = await db.one('SELECT p.*, u.username AS received_by_name FROM packages p LEFT JOIN users u ON u.id = p.received_by WHERE p.id = ?', [req.params.id]);
    if (!pkg) return res.status(404).render('error', { title: 'Not found', message: 'No such event report.' });
    const report = await db.one('SELECT * FROM event_reports WHERE package_id = ?', [pkg.id]);
    const payload = JSON.parse(pkg.payload);
    const taxes = await reports.taxesFor(report);
    await audit(req, 'view_event', 'package', pkg.id);
    res.render('event', { pkg, report, p: payload, taxes, checks: typeof pkg.checks === 'string' ? JSON.parse(pkg.checks) : pkg.checks });
  } catch (e) { next(e); }
});

// Printable closing report (same layout as the betting server's closing report).
router.get('/events/:id(\\d+)/print', requireRole(...ALL), async (req, res, next) => {
  try {
    const pkg = await db.one('SELECT p.*, u.full_name AS received_by_name FROM packages p LEFT JOIN users u ON u.id = p.received_by WHERE p.id = ?', [req.params.id]);
    if (!pkg) return res.status(404).render('error', { title: 'Not found', message: 'No such event report.' });
    const report = await db.one('SELECT * FROM event_reports WHERE package_id = ?', [pkg.id]);
    const p = JSON.parse(pkg.payload);
    const taxes = await reports.taxesFor(report);
    await audit(req, 'print_event', 'package', pkg.id);
    res.render('print-event', { pkg, report, p, taxes, printedAt: require('../util').nowLocal() });
  } catch (e) { next(e); }
});

router.get('/events/:id(\\d+)/ack.json', requireRole(...ALL), async (req, res, next) => {
  try {
    const pkg = await db.one('SELECT * FROM packages WHERE id = ?', [req.params.id]);
    if (!pkg) return res.status(404).end();
    res.set('Content-Disposition', `attachment; filename="ACK_${pkg.server_id}_S${String(pkg.sequence_no).padStart(4, '0')}.json"`);
    res.json({ format: 'sabonglara.ack/1', server_id: pkg.server_id, sequence_no: pkg.sequence_no, payload_sha256: pkg.payload_sha256,
      seal_code: pkg.seal_code, received_at: pkg.received_at, ack_code: pkg.ack_code, ack_signature: pkg.ack_signature });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ reports
const monthParam = (q) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(q || '') ? q : new Date().toISOString().slice(0, 7));

router.get('/reports/monthly', requireRole(...ALL), async (req, res, next) => {
  try {
    const r = await reports.monthly(monthParam(req.query.month));
    await audit(req, 'view_monthly_report', 'month', r.month);
    res.render('monthly', { r, TAX_BASES: reports.TAX_BASES });
  } catch (e) { next(e); }
});

router.get('/reports/monthly.csv', requireRole(...ALL), async (req, res, next) => {
  try {
    const r = await reports.monthly(monthParam(req.query.month));
    await audit(req, 'export_monthly_csv', 'month', r.month);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="monthly-${r.month}.csv"`);
    res.send('﻿' + reports.csvMonthly(r));
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- tax rules
router.get('/tax-rules', requireRole(...ALL), async (req, res, next) => {
  try {
    const rules = await db.query(`SELECT t.*, u.username AS created_by_name FROM tax_rules t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.retired_at IS NOT NULL, t.effective_from DESC`);
    res.render('tax-rules', { rules, TAX_BASES: reports.TAX_BASES, error: null });
  } catch (e) { next(e); }
});

router.post('/tax-rules', requireRole('admin'), async (req, res, next) => {
  try {
    const b = req.body;
    const problems = [];
    // "1" or a chain applied in order: "7 x 14 x 1" (also × or *). Labels optional: "Commission; Operator Safety Net; LGU tax".
    const pcts = String(b.rate_percent || '').trim().split(/\s*[x×*]\s*/i).filter(Boolean);
    const labels = String(b.rate_labels || '').split(';').map((s) => s.trim().slice(0, 60));
    let rate = null;
    if (!pcts.length || pcts.length > 6 || !pcts.every((p) => /^\d{1,3}(\.\d{1,4})?$/.test(p) && Number(p) > 0 && Number(p) <= 100)) {
      problems.push('Rate: one percentage (e.g. 1) or several multiplied in order (e.g. 7 x 14 x 1), each above 0 and at most 100, up to 4 decimals.');
    } else {
      rate = rateFromPercents(pcts);
      if ((rate.split('.')[1] || '').length > 12) { problems.push('Rate has too many decimal places.'); rate = null; }
    }
    const factors = rate ? JSON.stringify(pcts.map((p, i) => ({ pct: p, label: labels[i] || '' }))) : null;
    if (!b.name || !b.legal_basis) problems.push('Name and legal basis (ordinance / regulation) are required.');
    if (!['LGU', 'BIR'].includes(b.authority)) problems.push('Choose LGU or BIR.');
    if (!Object.keys(reports.TAX_BASES).includes(b.tax_base)) problems.push('Choose a tax base.');
    if (rate !== null && !(Number(rate) > 0 && Number(rate) < 1)) problems.push('The combined rate must be between 0 and 100%.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_from || '')) problems.push('Effective-from date is required.');
    if (problems.length) {
      const rules = await db.query('SELECT * FROM tax_rules ORDER BY effective_from DESC');
      return res.status(422).render('tax-rules', { rules, TAX_BASES: reports.TAX_BASES, error: problems.join(' ') });
    }
    const [ins] = await db.pool.query('INSERT INTO tax_rules SET ?', [{
      name: b.name.slice(0, 120), authority: b.authority, lgu: (b.lgu || '').slice(0, 120) || null, legal_basis: b.legal_basis.slice(0, 200),
      tax_base: b.tax_base, rate, factors, effective_from: b.effective_from,
      effective_to: /^\d{4}-\d{2}-\d{2}$/.test(b.effective_to || '') ? b.effective_to : null, created_by: req.session.user.id,
    }]);
    await audit(req, 'tax_rule_created', 'tax_rule', ins.insertId, { name: b.name, base: b.tax_base, rate, factors, from: b.effective_from });
    res.redirect('/tax-rules');
  } catch (e) { next(e); }
});

router.post('/tax-rules/:id(\\d+)/retire', requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(`UPDATE tax_rules SET retired_at = NOW(), retired_by = ?, effective_to = COALESCE(effective_to, CURDATE() - INTERVAL 1 DAY)
      WHERE id = ? AND retired_at IS NULL`, [req.session.user.id, req.params.id]);
    await audit(req, 'tax_rule_retired', 'tax_rule', req.params.id);
    res.redirect('/tax-rules');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- admin
router.get('/admin/users', requireRole('admin'), async (req, res, next) => {
  try { res.render('users', { users: await db.query('SELECT * FROM users ORDER BY role, username'), error: null, notice: null }); } catch (e) { next(e); }
});

router.post('/admin/users', requireRole('admin'), async (req, res, next) => {
  try {
    const b = req.body;
    const problem = !/^[a-z0-9._-]{3,60}$/i.test(b.username || '') ? 'Username: 3-60 letters, numbers, dot, dash or underscore.'
      : !['admin', 'accounting', 'treasury'].includes(b.role) ? 'Choose a role.'
        : !b.full_name ? 'Full name is required.' : passwordProblem(b.password);
    if (problem || await db.one('SELECT id FROM users WHERE username = ?', [b.username])) {
      return res.status(422).render('users', { users: await db.query('SELECT * FROM users ORDER BY role, username'), error: problem || 'That username already exists.', notice: null });
    }
    const [ins] = await db.pool.query('INSERT INTO users SET ?', [{ username: b.username, full_name: b.full_name.slice(0, 120), role: b.role, password_hash: await hashPassword(b.password) }]);
    await audit(req, 'user_created', 'user', ins.insertId, { username: b.username, role: b.role });
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.post('/admin/users/:id(\\d+)/toggle', requireRole('admin'), async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.session.user.id) return res.redirect('/admin/users');
    await db.query('UPDATE users SET is_active = 1 - is_active WHERE id = ?', [req.params.id]);
    await audit(req, 'user_toggled', 'user', req.params.id);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.get('/admin/servers', requireRole('admin'), async (req, res, next) => {
  try { res.render('servers', { servers: await db.query('SELECT * FROM betting_servers ORDER BY server_id'), error: null }); } catch (e) { next(e); }
});

router.post('/admin/servers/:id(\\d+)/revoke', requireRole('admin'), async (req, res, next) => {
  try {
    await db.query("UPDATE betting_servers SET status = 'revoked', revoked_at = NOW() WHERE id = ? AND status = 'active'", [req.params.id]);
    await audit(req, 'server_key_revoked', 'betting_server', req.params.id);
    res.redirect('/admin/servers');
  } catch (e) { next(e); }
});

router.get('/audit', requireRole('admin', 'treasury'), async (req, res, next) => {
  try {
    const { verifyChain } = require('../audit');
    const chain = await verifyChain();
    const rows = await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300');
    res.render('audit', { rows, chain });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------ own password
router.get('/account/password', requireRole(...ALL), (req, res) => res.render('password', { error: null, done: false }));

router.post('/account/password', requireRole(...ALL), async (req, res, next) => {
  try {
    const u = await db.one('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const bcrypt = require('bcryptjs');
    if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) return res.status(422).render('password', { error: 'Current password is incorrect.', done: false });
    const problem = passwordProblem(req.body.password) || (req.body.password !== req.body.confirm ? 'The new passwords do not match.' : null);
    if (problem) return res.status(422).render('password', { error: problem, done: false });
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(req.body.password), u.id]);
    await audit(req, 'password_changed', 'user', u.id);
    res.render('password', { error: null, done: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.helpers = { cents, fmt };
