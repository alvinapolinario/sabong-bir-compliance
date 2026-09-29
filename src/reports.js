'use strict';
const db = require('./db');
const { cents, fmt, percentOf } = require('./money');

const MONEY_COLS = ['gross_bets', 'voided_bets', 'net_bets', 'refunds', 'winnings', 'commission', 'breakage', 'house_take', 'payable', 'paid', 'unclaimed'];
const TAX_BASES = {
  house_take: 'House take (pool − winnings − refunds)',
  commission: 'Commission at the event rate',
  net_bets: 'Net bets (after voids)',
  gross_bets: 'Gross bets (before voids)',
};

async function rulesFor(date) {
  return db.query(
    `SELECT * FROM tax_rules WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY authority, name`, [date, date]);
}

/** Tax lines for one event, from the rules in force on the event date. */
async function taxesFor(report) {
  const rules = await rulesFor(report.event_date);
  return rules.map((r) => {
    const base = cents(report[r.tax_base]);
    const tax = base > 0n ? percentOf(base, r.rate) : 0n;
    return { rule: r, base: fmt(base), tax: fmt(tax) };
  });
}

async function monthly(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const events = await db.query(
    `SELECT r.*, p.sequence_no, p.seal_code, p.received_at, p.ack_code
     FROM event_reports r JOIN packages p ON p.id = r.package_id
     WHERE r.event_date BETWEEN ? AND ? ORDER BY r.event_date, p.sequence_no`, [from, to]);

  const totals = Object.fromEntries(MONEY_COLS.map((k) => [k, 0n]));
  const taxTotals = new Map();
  for (const e of events) {
    for (const k of MONEY_COLS) totals[k] += cents(e[k]);
    e.taxes = await taxesFor(e);
    for (const t of e.taxes) {
      const key = t.rule.id;
      const cur = taxTotals.get(key) || { rule: t.rule, base: 0n, tax: 0n };
      cur.base += cents(t.base);
      cur.tax += cents(t.tax);
      taxTotals.set(key, cur);
    }
  }

  // Missing sequence numbers inside the month = events not uploaded yet.
  const bySrv = {};
  const prefix = {};
  for (const e of events) { (bySrv[e.server_id] ||= []).push(e.sequence_no); prefix[e.server_id] = e.origin === 'legacy' ? 'L' : 'S'; }
  const gaps = [];
  for (const [srv, seqs] of Object.entries(bySrv)) {
    for (let s = Math.min(...seqs); s <= Math.max(...seqs); s++) if (!seqs.includes(s)) gaps.push(`${srv} ${prefix[srv]}${String(s).padStart(4, '0')}`);
  }

  return {
    month, from, to, events, gaps,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, fmt(v)])),
    taxTotals: [...taxTotals.values()].map((t) => ({ rule: t.rule, base: fmt(t.base), tax: fmt(t.tax) })),
  };
}

function csvMonthly(r) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Date', 'Event', 'Origin', 'Package', 'Seal code', 'Fights', ...MONEY_COLS.map((k) => k.replace(/_/g, ' ')), ...r.taxTotals.map((t) => `Tax: ${t.rule.name}`)];
  const rows = r.events.map((e) => [e.event_date, e.event_name, e.origin === 'legacy' ? 'LEGACY (reconstructed from backup)' : 'Live seal', `${e.origin === 'legacy' ? 'L' : 'S'}${String(e.sequence_no).padStart(4, '0')}`, e.seal_code, e.fights_total,
    ...MONEY_COLS.map((k) => e[k]), ...r.taxTotals.map((t) => (e.taxes.find((x) => x.rule.id === t.rule.id) || {}).tax || '0.00')]);
  const total = ['TOTAL', '', '', '', '', r.events.reduce((a, e) => a + e.fights_total, 0), ...MONEY_COLS.map((k) => r.totals[k]), ...r.taxTotals.map((t) => t.tax)];
  return [head, ...rows, total].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n';
}

module.exports = { monthly, csvMonthly, taxesFor, TAX_BASES, MONEY_COLS };
