// Ported unchanged from garden-companion.html.
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(year, month, day) { return year + '-' + pad2(month) + '-' + pad2(day); }
function uid() { return Math.random().toString(36).slice(2, 10); }

module.exports = { todayISO, isoDate, uid };
