'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const req = (name) => {
  const v = process.env[name];
  if (!v || v === 'change-me') throw new Error(`Missing configuration: ${name} (see .env.example)`);
  return v;
};

module.exports = {
  root,
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.PORT || 8090),
  host: process.env.HOST || '127.0.0.1',
  appUrl: process.env.APP_URL || 'http://localhost:8090',
  arenaName: process.env.ARENA_NAME || 'Blueknife Gallera',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'bir_compliance',
    user: process.env.DB_USER || 'bir_app',
    password: process.env.DB_PASSWORD || '',
  },
  sessionSecret: () => req('SESSION_SECRET'),
  sessionHours: Number(process.env.SESSION_HOURS || 8),
  keyPath: path.resolve(root, process.env.KEY_PATH || './keys'),
  packagePath: path.resolve(root, process.env.PACKAGE_PATH || './storage/packages'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024,
  // Must match the betting server (config/sealing.php).
  payloadFormat: 'sabonglara.closing/1',
  packageFormat: 'sabonglara.closing-package/1',
  genesis: '0'.repeat(64),
};
