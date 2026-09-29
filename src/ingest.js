'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { ready, signSecret, sha256 } = require('./crypto');
const { verifyPackage } = require('./verify');
const { cents, fmt } = require('./money');
const { nowLocal } = require('./util');

const findServer = (fp) => db.one('SELECT * FROM betting_servers WHERE key_fingerprint = ?', [fp]);

/** Acknowledgment: signed by this system, short code typed back into the betting server. */
async function makeAck(serverId, sequenceNo, payloadHash, receivedAt, legacy = false) {
  const sodium = await ready();
  const message = `sabonglara-ack/1|${serverId}|${sequenceNo}|${payloadHash}|${receivedAt}`;
  const signature = Buffer.from(sodium.crypto_sign_detached(Buffer.from(message), signSecret())).toString('base64');
  const code = `ACK-${legacy ? 'L' : 'S'}${String(sequenceNo).padStart(4, '0')}-${sha256(signature).slice(0, 12).toUpperCase().match(/.{4}/g).join('-')}`;
  return { message, signature, code };
}

async function recordAttempt(conn, a) {
  await conn.query('INSERT INTO upload_attempts SET ?', [{
    file_name: a.fileName.slice(0, 255), file_sha256: a.fileSha, server_id: a.serverId || null,
    sequence_no: a.sequenceNo || null, result: a.result, reasons: JSON.stringify(a.reasons),
    uploaded_by: a.userId, uploaded_from: a.ip || null, uploaded_at: nowLocal(),
  }]);
}

/**
 * Verifies and stores one uploaded package.
 * @returns {{result:'accepted'|'duplicate'|'rejected', checks:object[], packageId?:number, ackCode?:string, sealCode?:string, event?:object}}
 */
async function ingestUpload({ buffer, fileName, userId, ip }) {
  const fileSha = sha256(buffer);
  const v = await verifyPackage(buffer, findServer);
  const checks = [...v.results];
  const failed = () => checks.filter((c) => !c.passed);
  const serverId = v.outer && typeof v.outer.server_id === 'string' ? v.outer.server_id.slice(0, 60) : null;
  const sequenceNo = v.outer && Number.isInteger(Number(v.outer.sequence_no)) ? Number(v.outer.sequence_no) : null;

  if (failed().length || !v.payload) {
    await db.tx((conn) => recordAttempt(conn, { fileName, fileSha, serverId, sequenceNo, result: 'rejected', reasons: failed(), userId, ip }));
    return { result: 'rejected', checks };
  }

  const p = v.payload;
  let storedPath = null;
  try {
    return await db.tx(async (conn) => {
      // Serialise uploads per betting server so the sequence chain cannot fork.
      await conn.query('SELECT id FROM betting_servers WHERE server_id = ? FOR UPDATE', [p.server_id]);

      const [[same]] = await conn.query('SELECT * FROM packages WHERE server_id = ? AND sequence_no = ?', [p.server_id, p.sequence_no]);
      if (same) {
        if (same.payload_sha256 === v.payloadHash) {
          checks.push({ name: 'already_received', passed: true, detail: `Received earlier on ${same.received_at}; returning the original acknowledgment.` });
          await recordAttempt(conn, { fileName, fileSha, serverId: p.server_id, sequenceNo: p.sequence_no, result: 'duplicate', reasons: [], userId, ip });
          return { result: 'duplicate', checks, packageId: same.id, ackCode: same.ack_code, sealCode: same.seal_code, event: p.event };
        }
        checks.push({ name: 'sequence_not_reused', passed: false,
          detail: `CONFLICT: package S${String(p.sequence_no).padStart(4, '0')} was already accepted with different contents (seal ${same.seal_code}). Possible tampering or a restored betting server.` });
        await recordAttempt(conn, { fileName, fileSha, serverId: p.server_id, sequenceNo: p.sequence_no, result: 'rejected', reasons: failed(), userId, ip });
        return { result: 'rejected', checks };
      }

      const [[last]] = await conn.query('SELECT sequence_no, payload_sha256 FROM packages WHERE server_id = ? ORDER BY sequence_no DESC LIMIT 1', [p.server_id]);
      const expectedSeq = last ? last.sequence_no + 1 : 1;
      const expectedPrev = last ? last.payload_sha256 : config.genesis;
      checks.push({ name: 'sequence_in_order', passed: Number(p.sequence_no) === expectedSeq,
        detail: Number(p.sequence_no) > expectedSeq
          ? `Package S${String(expectedSeq).padStart(4, '0')} is missing. Upload the missing event(s) first.`
          : `Expected package S${String(expectedSeq).padStart(4, '0')}.` });
      checks.push({ name: 'chain_continues', passed: p.prev_payload_sha256 === expectedPrev,
        detail: 'The previous-seal fingerprint does not match the last package received from this betting server.' });
      if (failed().length) {
        await recordAttempt(conn, { fileName, fileSha, serverId: p.server_id, sequenceNo: p.sequence_no, result: 'rejected', reasons: failed(), userId, ip });
        return { result: 'rejected', checks };
      }

      // Keep the original file exactly as received (read-only).
      const dir = path.join(config.packagePath, p.server_id.replace(/[^A-Za-z0-9_.-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      storedPath = path.join(dir, `${p.origin && p.origin.type === 'legacy_backup' ? 'L' : 'S'}${String(p.sequence_no).padStart(4, '0')}_${v.payloadHash.slice(0, 16)}.pkg.enc`);
      fs.writeFileSync(storedPath, buffer, { flag: 'wx', mode: 0o440 });

      const receivedAt = nowLocal();
      const isLegacy = !!(p.origin && p.origin.type === 'legacy_backup');
      const ack = await makeAck(p.server_id, p.sequence_no, v.payloadHash, receivedAt, isLegacy);
      const [ins] = await conn.query('INSERT INTO packages SET ?', [{
        server_id: p.server_id, sequence_no: p.sequence_no, event_id: p.event.event_id, seal_code: v.outer.seal_code,
        payload_sha256: v.payloadHash, prev_payload_sha256: p.prev_payload_sha256, key_fingerprint: v.envelope.key_fingerprint,
        payload: v.envelope.payload, signature: v.envelope.signature, file_name: fileName.slice(0, 255), file_sha256: fileSha,
        stored_path: path.relative(config.root, storedPath), checks: JSON.stringify(checks),
        ack_code: ack.code, ack_signature: ack.signature, received_at: receivedAt, received_by: userId,
      }]);

      const t = p.totals;
      const houseTake = t.house_take !== undefined ? t.house_take : fmt(cents(t.commission) + cents(t.breakage));
      await conn.query('INSERT INTO event_reports SET ?', [{
        package_id: ins.insertId, server_id: p.server_id, origin: p.origin && p.origin.type === 'legacy_backup' ? 'legacy' : 'live', event_id: p.event.event_id, event_name: String(p.event.name).slice(0, 200),
        event_date: p.event.date, commission_rate: p.event.commission_rate,
        fights_total: t.fights_total, fights_completed: t.fights_completed, fights_draw: t.fights_draw, fights_cancelled: t.fights_cancelled,
        gross_bets: t.gross_bets, voided_bets: t.voided_bets, net_bets: t.net_bets, refunds: t.refunds, winnings: t.winnings,
        commission: t.commission, breakage: t.breakage, house_take: houseTake, payable: t.payable, paid: t.paid, unclaimed: t.unclaimed,
        flagged_checks: (p.checks || []).filter((c) => !c.passed).length,
      }]);
      await recordAttempt(conn, { fileName, fileSha, serverId: p.server_id, sequenceNo: p.sequence_no, result: 'accepted', reasons: [], userId, ip });

      return { result: 'accepted', checks, packageId: ins.insertId, ackCode: ack.code, sealCode: v.outer.seal_code, event: p.event };
    });
  } catch (e) {
    if (storedPath && fs.existsSync(storedPath)) { try { fs.chmodSync(storedPath, 0o600); fs.unlinkSync(storedPath); } catch {} }
    throw e;
  }
}

module.exports = { ingestUpload, makeAck };
