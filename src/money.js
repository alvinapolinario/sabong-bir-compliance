'use strict';
/**
 * Exact money arithmetic in integer centavos (BigInt), matching the betting
 * server's App\Services\Closing\Money. Amounts travel as fixed 2-decimal strings.
 */

/** "1234.50" / "-0.05" -> 123450n / -5n (truncates beyond 2 decimals, like bcmul). */
function cents(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Not a money amount: ${s}`);
  const frac = ((m[3] || '') + '00').slice(0, 2);
  const v = BigInt(m[2]) * 100n + BigInt(frac);
  return m[1] ? -v : v;
}

/** 123450n -> "1234.50" */
function fmt(c) {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Display: 1234567.5 -> "1,234,567.50" */
function peso(value) {
  const s = fmt(cents(value));
  const [i, d] = s.replace('-', '').split('.');
  return `${s.startsWith('-') ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`;
}

/**
 * cents x rate (decimal string, e.g. "0.070"), rounded half-up to the
 * centavo, exactly as Money::percentOf() on the betting server.
 */
function percentOf(c, rate) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(rate).trim());
  if (!m) throw new Error(`Not a rate: ${rate}`);
  const decimals = (m[2] || '').length;
  const num = BigInt(m[1] + (m[2] || ''));
  const den = 10n ** BigInt(decimals);
  const neg = c < 0n;
  const p = (neg ? -c : c) * num;
  let q = p / den;
  if ((p % den) * 2n >= den) q += 1n;
  return neg ? -q : q;
}

/** Trim a decimal string: "0.009800000000" -> "0.0098", "1.000" -> "1". */
function trimDecimal(s) {
  s = String(s);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Exact product of percentages as a rate (fraction) decimal string, e.g.
 * ["7", "14", "1"] -> "0.000098". No rounding: every step is kept exactly and
 * only the final tax is rounded to the centavo (percentOf).
 */
function rateFromPercents(pcts) {
  let num = 1n;
  let scale = 0;
  for (const p of pcts) {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(p).trim());
    if (!m) throw new Error(`Not a percentage: ${p}`);
    num *= BigInt(m[1] + (m[2] || ''));
    scale += (m[2] || '').length + 2; // + 2: percent -> fraction
  }
  const digits = num.toString().padStart(scale + 1, '0');
  return trimDecimal(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}

/** A rate (fraction, decimal string) shown as an exact percentage: "0.000098" -> "0.0098". */
function ratePercent(rate) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(trimDecimal(String(rate).trim()));
  if (!m) return String(rate);
  const frac = (m[2] || '').padEnd(2, '0');
  const whole = (BigInt(m[1] + frac.slice(0, 2))).toString();
  return trimDecimal(frac.length > 2 ? `${whole}.${frac.slice(2)}` : whole);
}

module.exports = { cents, fmt, peso, percentOf, rateFromPercents, ratePercent, trimDecimal };
