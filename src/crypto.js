'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const _sodium = require('libsodium-wrappers');
const config = require('./config');

/**
 * VPS keys (never leave the VPS):
 *   vps-enc.key   X25519 key pair, base64(secret||public) - the betting server
 *                 encrypts packages to the public half (SEAL_VPS_PUBLIC_KEY).
 *   vps-sign.key  Ed25519 secret key, base64 - signs acknowledgments.
 */
let sodium;
async function ready() {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  return sodium;
}

const keyFile = (name) => path.join(config.keyPath, name);
const readB64 = (name) => Buffer.from(fs.readFileSync(keyFile(name), 'utf8').trim(), 'base64');

function encKeypair() {
  const raw = readB64('vps-enc.key');
  if (raw.length !== 64) throw new Error('vps-enc.key must hold 64 bytes (secret||public)');
  return { secretKey: raw.subarray(0, 32), publicKey: raw.subarray(32, 64) };
}

function signSecret() {
  const raw = readB64('vps-sign.key');
  if (raw.length !== 64) throw new Error('vps-sign.key must hold a 64-byte Ed25519 secret key');
  return raw;
}

function writeSecret(name, buf) {
  fs.mkdirSync(config.keyPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(name), buf.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Same as KeyStore::fingerprint() on the betting server. */
const fingerprint = (publicKey) => sha256(publicKey).slice(0, 16);

/** Same as EventSealer::sealCode() on the betting server. */
const sealCode = (hash) => hash.slice(0, 16).toUpperCase().match(/.{4}/g).join('-');

module.exports = { ready, encKeypair, signSecret, writeSecret, keyFile, sha256, fingerprint, sealCode };
