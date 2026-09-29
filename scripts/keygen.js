'use strict';
// Creates the VPS keys (run once on the VPS):
//   node scripts/keygen.js
// Prints the ENCRYPTION PUBLIC KEY to put in the betting server's .env as
// SEAL_VPS_PUBLIC_KEY. The private halves never leave this machine.
//
// SANDBOX ONLY: reuse the betting sandbox's stand-in key so its test packages decrypt:
//   node scripts/keygen.js --import-enc-keypair <base64 of storage/app/keys/vps-test.key>
const fs = require('fs');
const { ready, writeSecret, keyFile, fingerprint } = require('../src/crypto');

(async () => {
  const sodium = await ready();
  const args = process.argv.slice(2);
  const importIdx = args.indexOf('--import-enc-keypair');

  if (fs.existsSync(keyFile('vps-enc.key'))) {
    console.log('vps-enc.key already exists (not replaced).');
  } else if (importIdx !== -1) {
    const raw = Buffer.from(args[importIdx + 1] || '', 'base64');
    if (raw.length !== 64) throw new Error('The imported key pair must be 64 bytes (base64 of secret||public).');
    writeSecret('vps-enc.key', raw);
    console.log('Imported encryption key pair (SANDBOX TEST KEY - never use in production).');
  } else {
    const kp = sodium.crypto_box_keypair();
    writeSecret('vps-enc.key', Buffer.concat([Buffer.from(kp.privateKey), Buffer.from(kp.publicKey)]));
    console.log('Created encryption key pair: keys/vps-enc.key');
  }

  if (fs.existsSync(keyFile('vps-sign.key'))) {
    console.log('vps-sign.key already exists (not replaced).');
  } else {
    const kp = sodium.crypto_sign_keypair();
    writeSecret('vps-sign.key', Buffer.from(kp.privateKey));
    fs.writeFileSync(keyFile('vps-sign.pub'), Buffer.from(kp.publicKey).toString('base64') + '\n', { mode: 0o644 });
    console.log('Created acknowledgment signing key: keys/vps-sign.key');
  }

  const enc = Buffer.from(fs.readFileSync(keyFile('vps-enc.key'), 'utf8').trim(), 'base64');
  const encPub = enc.subarray(32, 64);
  console.log('\nPut this on the BETTING SERVER (.env):');
  console.log(`  SEAL_VPS_PUBLIC_KEY=${encPub.toString('base64')}`);
  console.log(`  (fingerprint ${fingerprint(encPub)})`);
  console.log('\nBack up the keys/ folder to sealed offline storage. Losing vps-enc.key means packages can no longer be opened.');
})().catch((e) => { console.error(e.message); process.exit(1); });
