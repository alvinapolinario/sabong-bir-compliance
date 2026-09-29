'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  decimalNumbers: false, // keep DECIMAL as exact strings
  timezone: '+08:00',
});

module.exports = {
  pool,
  query: (sql, params) => pool.query(sql, params).then(([rows]) => rows),
  one: (sql, params) => pool.query(sql, params).then(([rows]) => rows[0] || null),
  /** Runs fn(conn) inside a transaction. */
  async tx(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  },
};
