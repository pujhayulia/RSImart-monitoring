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

/** {dari, sampai} ("YYYY-MM-DD") untuk bulan berjalan (waktu lokal) — dipakai untuk statistik "bulan ini". */
export function monthRange(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    dari: `${y}-${pad(m + 1)}-01`,
    sampai: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
  };
}

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** Ubah Firestore Timestamp (atau Date) jadi string tanggal+jam lokal, mis. "26 Agu 2026, 14:30". */
export function formatTimestamp(ts) {
  if (!ts) return '-';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  const d = String(date.getDate()).padStart(2, '0');
  const jam = String(date.getHours()).padStart(2, '0');
  const menit = String(date.getMinutes()).padStart(2, '0');
  return `${d} ${BULAN[date.getMonth()]} ${date.getFullYear()}, ${jam}:${menit}`;
}

/** Ubah Firestore Timestamp (atau Date) jadi "YYYY-MM-DD" berdasarkan waktu lokal (bukan UTC), untuk dibandingkan dengan input type=date. */
export function timestampToLocalDateIso(ts) {
  if (!ts) return '';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** true jika tanggal (Firestore Timestamp) berada di antara dari/sampai ("YYYY-MM-DD", boleh kosong = tak terbatas). */
export function isTimestampInRange(ts, dari, sampai) {
  const iso = timestampToLocalDateIso(ts);
  if (!iso) return false;
  if (dari && iso < dari) return false;
  if (sampai && iso > sampai) return false;
  return true;
}

/** true jika tanggal ("YYYY-MM-DD", mis. dari input type=date) berada di antara dari/sampai (boleh kosong = tak terbatas). */
export function isDateStrInRange(dateStr, dari, sampai) {
  if (!dateStr) return false;
  if (dari && dateStr < dari) return false;
  if (sampai && dateStr > sampai) return false;
  return true;
}
