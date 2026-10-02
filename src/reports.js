'use strict';
const db = require('./db');
const { cents, fmt, percentOf, ratePercent } = require('./money');

const MONEY_COLS = ['gross_bets', 'voided_bets', 'net_bets', 'refunds', 'winnings', 'commission', 'breakage', 'house_take', 'payable', 'paid', 'unclaimed'];
const TAX_BASES = {
  house_take: 'House take (pool − winnings − refunds)',
  commission: 'Commission at the event rate',
  net_bets: 'Net bets (after voids)',
  gross_bets: 'Gross bets (before voids)',
  taxable_bets: 'Taxable bets (net bets − draw/cancelled refunds)',
};

const BASE_SHORT = { house_take: 'House take', commission: 'Commission', net_bets: 'Net bets', gross_bets: 'Gross bets', taxable_bets: 'Taxable bets' };

/**
 * Taxable bets in centavos: bets on fights that had a winner (net bets minus the
 * draw/cancelled pools refunded) = the pool the commission is taken from
 * = winnings + commission + rounding. Works on report rows and sealed totals.
 */
function taxableCents(r) {
  return cents(r.winnings) + cents(r.commission) + cents(r.breakage);
}
function taxableBets(r) { return fmt(taxableCents(r)); }

function baseCents(report, base) {
  return base === 'taxable_bets' ? taxableCents(report) : cents(report[base]);
}

function factorsOf(rule) {
  if (!rule.factors) return null;
  try { const f = JSON.parse(rule.factors); return Array.isArray(f) && f.length ? f : null; } catch { return null; }
}

/** "7% × 14% × 1% = 0.0098%" for a chained rule, "1%" for a single rate. */
function rateText(rule) {
  const f = factorsOf(rule);
  const total = `${ratePercent(rule.rate)}%`;
  return f && f.length > 1 ? `${f.map((x) => `${x.pct}%`).join(' × ')} = ${total}` : total;
}

/** "Gross bets × 7% (Commission) × 14% (Operator Safety Net) × 1% (LGU tax)", or null for a single unlabeled rate. */
function formulaText(rule) {
  const f = factorsOf(rule);
  if (!f || (f.length === 1 && !f[0].label)) return null;
  return [BASE_SHORT[rule.tax_base] || rule.tax_base, ...f.map((x) => `${x.pct}%${x.label ? ` (${x.label})` : ''}`)].join(' × ');
}

async function rulesFor(date) {
  return db.query(
    `SELECT * FROM tax_rules WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY authority, name`, [date, date]);
}

/** Tax lines for one event, from the rules in force on the event date. */
async function taxesFor(report) {
  const rules = await rulesFor(report.event_date);
  return rules.map((r) => {
    const base = baseCents(report, r.tax_base);
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

  const totals = Object.fromEntries([...MONEY_COLS, 'taxable_bets'].map((k) => [k, 0n]));
  const taxTotals = new Map();
  for (const e of events) {
    for (const k of MONEY_COLS) totals[k] += cents(e[k]);
    e.taxable_bets = taxableBets(e);
    totals.taxable_bets += taxableCents(e);
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
  const head = ['Date', 'Event', 'Origin', 'Package', 'Seal code', 'Fights', ...MONEY_COLS.map((k) => k.replace(/_/g, ' ')), 'taxable bets', ...r.taxTotals.map((t) => `Tax: ${t.rule.name}`)];
  const rows = r.events.map((e) => [e.event_date, e.event_name, e.origin === 'legacy' ? 'LEGACY (reconstructed from backup)' : 'Live seal', `${e.origin === 'legacy' ? 'L' : 'S'}${String(e.sequence_no).padStart(4, '0')}`, e.seal_code, e.fights_total,
    ...MONEY_COLS.map((k) => e[k]), e.taxable_bets, ...r.taxTotals.map((t) => (e.taxes.find((x) => x.rule.id === t.rule.id) || {}).tax || '0.00')]);
  const total = ['TOTAL', '', '', '', '', r.events.reduce((a, e) => a + e.fights_total, 0), ...MONEY_COLS.map((k) => r.totals[k]), r.totals.taxable_bets, ...r.taxTotals.map((t) => t.tax)];
  return [head, ...rows, total].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n';
}

module.exports = { monthly, csvMonthly, taxesFor, TAX_BASES, MONEY_COLS, rateText, formulaText, taxableBets };
