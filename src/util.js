'use strict';

/** Current time in Asia/Manila as "YYYY-MM-DD HH:MM:SS[.mmm]" (DB-friendly). */
function nowLocal(withMs = false) {
  const d = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const base = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

module.exports = { nowLocal };
