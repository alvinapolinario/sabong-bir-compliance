'use strict';
const db = require('./db');
const { sha256 } = require('./crypto');
const config = require('./config');
const { nowLocal } = require('./util');

/**
 * Append-only, hash-chained audit log. Each entry's hash covers the previous
 * entry's hash, so removing or editing any entry breaks the chain.
 * A table lock serialises writers so the chain never forks.
 */
async function audit(req, action, entity = null, entityId = null, detail = null) {
  const user = req && req.session && req.session.user;
  const conn = await db.pool.getConnection();
  try {
    await conn.query('LOCK TABLES audit_log WRITE');
    const [[last]] = await conn.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last ? last.hash : config.genesis;
    const at = nowLocal(true);
    const row = {
      at, user_id: user ? user.id : null, username: user ? user.username : null, role: user ? user.role : null,
      ip: req ? (req.ip || null) : null, action, entity, entity_id: entityId === null ? null : String(entityId),
      detail: detail === null ? null : JSON.stringify(detail),
    };
    const hash = sha256(prev + '|' + JSON.stringify(row));
    await conn.query('INSERT INTO audit_log SET ?', [{ ...row, prev_hash: prev, hash }]);
  } finally {
    await conn.query('UNLOCK TABLES').catch(() => {});
    conn.release();
  }
}

/** Recomputes the whole chain. Returns the first broken entry id, or null. */
async function verifyChain() {
  const rows = await db.query('SELECT * FROM audit_log ORDER BY id');
  let prev = config.genesis;
  for (const r of rows) {
    const row = {
      at: r.at, user_id: r.user_id, username: r.username, role: r.role, ip: r.ip, action: r.action,
      entity: r.entity, entity_id: r.entity_id, detail: r.detail === null ? null : (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)),
    };
    if (r.prev_hash !== prev || sha256(prev + '|' + JSON.stringify(row)) !== r.hash) return { ok: false, brokenAt: r.id, total: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, total: rows.length };
}

module.exports = { audit, verifyChain };
