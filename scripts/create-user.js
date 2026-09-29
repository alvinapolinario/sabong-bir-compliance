'use strict';
// Creates a user from the command line (use it for the first administrator):
//   node scripts/create-user.js --username admin --name "System Administrator" --role admin
// The password is read from the BIR_NEW_PASSWORD environment variable, or asked for interactively.
const readline = require('readline');
const db = require('../src/db');
const { hashPassword, passwordProblem } = require('../src/auth');

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
  const username = arg('--username');
  const fullName = arg('--name') || username;
  const role = arg('--role');
  if (!username || !/^[a-z0-9._-]{3,60}$/i.test(username)) throw new Error('--username is required (3-60 letters, numbers, dot, dash, underscore).');
  if (!['admin', 'accounting', 'treasury'].includes(role)) throw new Error('--role must be admin, accounting or treasury.');
  const password = process.env.BIR_NEW_PASSWORD || await ask('Password (min 10 characters, letters and numbers): ');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if (await db.one('SELECT id FROM users WHERE username = ?', [username])) throw new Error('That username already exists.');
  await db.query('INSERT INTO users SET ?', [{ username, full_name: fullName, role, password_hash: await hashPassword(password) }]);
  const { audit } = require('../src/audit');
  await audit(null, 'user_created', 'user', username, { role, via: 'cli' });
  console.log(`Created ${role} user "${username}".`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
