'use strict';
// Registers an onsite betting server's signing public key:
//   node scripts/register-server.js --server-id arena01-srv01 --name "Blueknife Gallera betting server" --public-key <base64 from `php artisan seal:keygen`>
// Only packages signed by a registered, active key are accepted.
const db = require('../src/db');
const { fingerprint } = require('../src/crypto');

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };

(async () => {
  const serverId = arg('--server-id');
  const name = arg('--name') || serverId;
  const pub = Buffer.from(arg('--public-key') || '', 'base64');
  const kind = arg('--kind') || 'live';
  if (!['live', 'legacy'].includes(kind)) throw new Error('--kind must be live or legacy.');
  if (!serverId || !/^[A-Za-z0-9._-]{1,60}$/.test(serverId)) throw new Error('--server-id is required (letters, numbers, dot, dash, underscore).');
  if (pub.length !== 32) throw new Error('--public-key must be the base64 Ed25519 public key (32 bytes) printed by `php artisan seal:keygen`.');
  const fp = fingerprint(pub);
  const existing = await db.one('SELECT * FROM betting_servers WHERE server_id = ? OR key_fingerprint = ?', [serverId, fp]);
  if (existing) throw new Error(`Already registered: ${existing.server_id} (key ${existing.key_fingerprint}, ${existing.status}).`);
  await db.query('INSERT INTO betting_servers SET ?', [{ server_id: serverId, name, kind, public_key_b64: pub.toString('base64'), key_fingerprint: fp }]);
  const { audit } = require('../src/audit');
  await audit(null, 'server_registered', 'betting_server', serverId, { fingerprint: fp, kind, via: 'cli' });
  console.log(`Registered ${serverId} as a ${kind} sender (key fingerprint ${fp}).`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
