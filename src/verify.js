'use strict';
/**
 * Verifies an encrypted closing package from the onsite betting server.
 * Port of App\Services\Closing\EventSealer::verifyPackage() (betting server),
 * so both systems apply exactly the same rules.
 *
 * Only cryptographic and arithmetic checks happen here. Sequence/chain checks
 * need the database and are done in ingest.js.
 */
const config = require('./config');
const { ready, encKeypair, sha256, fingerprint, sealCode } = require('./crypto');
const { cents, percentOf } = require('./money');

const SETTLED = ['Completed', 'Draw', 'Cancelled'];

/**
 * @param {Buffer|string} contents   the uploaded .pkg.enc file
 * @param {(fp: string) => Promise<{server_id:string, public_key_b64:string, status:string}|null>} findServerByFingerprint
 */
async function verifyPackage(contents, findServerByFingerprint) {
  const sodium = await ready();
  const results = [];
  const check = (name, passed, detail = '') => {
    results.push({ name, passed: !!passed, detail: passed ? 'ok' : detail });
    return !!passed;
  };
  const out = { results, outer: null, envelope: null, payload: null, server: null, payloadHash: null };

  let outer;
  try { outer = JSON.parse(Buffer.isBuffer(contents) ? contents.toString('utf8') : contents); } catch { outer = null; }
  if (!check('package_readable', outer && typeof outer.ciphertext === 'string' && outer.format === config.packageFormat,
    'Not a Sabonglara closing package (.pkg.enc).')) return out;
  out.outer = outer;

  let inner = null;
  try {
    const { publicKey, secretKey } = encKeypair();
    inner = sodium.crypto_box_seal_open(Buffer.from(outer.ciphertext, 'base64'), publicKey, secretKey);
  } catch { inner = null; }
  if (!check('decrypts_with_vps_key', inner, 'Cannot decrypt: the package was not encrypted for this system, or it was altered.')) return out;

  let env;
  try { env = JSON.parse(Buffer.from(inner).toString('utf8')); } catch { env = null; }
  if (!check('envelope_readable', env && typeof env.payload === 'string' && typeof env.signature === 'string', 'Decrypted contents are not a valid envelope.')) return out;
  out.envelope = env;

  const hash = sha256(env.payload);
  out.payloadHash = hash;
  check('hash_matches', hash === env.payload_sha256 && hash === outer.payload_sha256, 'Payload hash differs from the declared hash.');
  check('seal_code_matches', sealCode(hash) === outer.seal_code, 'Seal code differs from the payload.');

  const server = await findServerByFingerprint(env.key_fingerprint);
  out.server = server;
  if (!check('key_is_registered', server && server.status === 'active' && server.server_id === outer.server_id,
    server ? (server.status !== 'active' ? 'The signing key of this betting server has been revoked.' : 'Server name does not match the registered key.')
      : 'Signed by a betting server that is not registered here.')) return out;

  const pub = Buffer.from(server.public_key_b64, 'base64');
  let sigOk = false;
  try {
    sigOk = fingerprint(pub) === env.key_fingerprint
      && sodium.crypto_sign_verify_detached(Buffer.from(env.signature, 'base64'), Buffer.from(env.payload, 'utf8'), pub);
  } catch { sigOk = false; }
  if (!check('signature_valid', sigOk, 'Signature is invalid: the report was altered or not signed by this betting server.')) return out;

  let p;
  try { p = JSON.parse(env.payload); } catch { p = null; }
  if (!check('payload_readable', p && p.format === config.payloadFormat && p.event && p.totals && Array.isArray(p.fights) && Array.isArray(p.tellers),
    'Payload is not a supported closing report.')) return out;
  out.payload = p;
  const isLegacy = !!(p.origin && p.origin.type === 'legacy_backup');
  check('origin_matches_sender', isLegacy === (server.kind === 'legacy'),
    isLegacy ? 'A legacy (reconstructed) report must come from the registered legacy sender.'
      : 'The legacy sender can only send reconstructed (legacy) reports.');
  check('header_consistent', p.server_id === outer.server_id && Number(p.sequence_no) === Number(outer.sequence_no)
    && Number(p.event.event_id) === Number(outer.event_id), 'Package header does not match the signed report.');

  // ---- arithmetic re-checks, using only the signed payload ----
  const c = cents;
  const sum = (rows, k) => rows.reduce((a, r) => a + c(r[k]), 0n);
  const t = p.totals;

  check('fight_rows_balance', p.fights.every((f) =>
    c(f.net_pool) === c(f.meron_total) + c(f.wala_total)
    && c(f.payable) === c(f.paid) + c(f.unclaimed)
    && (!SETTLED.includes(f.status) || c(f.net_pool) === c(f.refunds) + c(f.winnings) + c(f.commission) + c(f.breakage))
    && (f.house_take === undefined || c(f.house_take) === c(f.commission) + c(f.breakage))),
  'A fight row does not balance.');

  check('totals_equal_fight_sums',
    c(t.commission) === sum(p.fights, 'commission') && c(t.winnings) === sum(p.fights, 'winnings')
    && c(t.refunds) === sum(p.fights, 'refunds') && c(t.paid) === sum(p.fights, 'paid'),
    'Event totals differ from the sum of the fights.');

  check('net_bets_balance',
    c(t.net_bets) === c(t.gross_bets) - c(t.voided_bets)
    && c(t.net_bets) === c(t.refunds) + c(t.winnings) + c(t.commission) + c(t.breakage) + c(t.unsettled_pool),
    'Net bets do not balance.');

  check('tellers_equal_fights', sum(p.tellers, 'net_bets') === sum(p.fights, 'net_pool'), 'Teller net bets differ from fight pools.');

  check('teller_rows_balance', p.tellers.every((r) =>
    c(r.expected_cash) === c(r.opening_cash) + c(r.cash_in) + c(r.net_bets) - c(r.payouts) - c(r.cash_out)),
  'A teller row does not balance.');

  check('commission_rate_applied', p.fights.every((f) => f.status !== 'Completed'
    || c(f.commission) === percentOf(c(f.net_pool), p.event.commission_rate)),
  'Commission differs from pool x commission rate.');

  return out;
}

module.exports = { verifyPackage, SETTLED };
