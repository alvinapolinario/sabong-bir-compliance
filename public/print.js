// Print buttons: <button data-print>Print</button>. Served from this site only (CSP script-src 'self').
document.querySelectorAll('[data-print]').forEach(function (b) {
  b.addEventListener('click', function () { window.print(); });
});
