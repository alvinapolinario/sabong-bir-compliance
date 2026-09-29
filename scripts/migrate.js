'use strict';
// Applies migrations/*.sql in order (idempotent: tables use IF NOT EXISTS,
// triggers are dropped and recreated). Statements in trigger files are
// separated by lines containing only "--;;".
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

(async () => {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  const dir = path.join(config.root, 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const parts = sql.includes('\n--;;') ? sql.split(/\n--;;\n?/) : sql.split(/;\s*$/m);
    for (const part of parts) {
      const stmt = part.replace(/^\s*--.*$/gm, '').trim();
      if (stmt) await conn.query(stmt);
    }
    console.log(`applied ${file}`);
  }
  await conn.end();
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
