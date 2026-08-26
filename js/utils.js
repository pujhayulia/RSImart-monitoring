// ---------- Fungsi bantu umum (format, escaping) ----------

export function formatRupiah(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

export function formatDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d} ${bulan[parseInt(m, 10) - 1]} ${y}`;
}

export function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
