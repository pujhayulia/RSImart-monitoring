// ---------- Backup Semua Data — unduh seluruh koleksi Firestore jadi satu file JSON ----------
// Dipasang di halaman Riwayat Aktivitas karena diakses dari modul mana pun. Selalu ambil data
// LANGSUNG dari Firestore (bukan dari cache state), supaya tidak kepotong oleh limit() milik
// masing-masing halaman dan hasilnya benar-benar lengkap.
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { logActivity } from './activity-log.js';

const COLLECTIONS = [
  'rekap', 'pengiriman', 'lokasi', 'poSppg', 'pembelianBahanMakanan',
  'distribusiSppg', 'biayaOperasional', 'activityLog',
];

function jsonReplacer(key, value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return value;
}

function fileTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${p(d.getDate())}${bulan[d.getMonth()]}${d.getFullYear()}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function fetchAll(name) {
  const snap = await getDocs(collection(state.db, name));
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
  return docs;
}

export async function downloadBackupSemuaData() {
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengambil data...'; }
  try {
    const collections = {};
    for (const name of COLLECTIONS) {
      collections[name] = await fetchAll(name);
    }
    const totalDokumen = Object.values(collections).reduce((sum, arr) => sum + arr.length, 0);

    const payload = {
      dibuatPada: new Date().toISOString(),
      dibuatOleh: state.currentUserEmail || 'tidak diketahui',
      totalDokumen,
      collections,
    };
    const json = JSON.stringify(payload, jsonReplacer, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Backup-RSI-Site-${fileTag()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logActivity({
      action: 'tambah',
      modul: 'Backup Data',
      ringkasan: `Unduh backup lengkap seluruh data (${totalDokumen} dokumen dari ${COLLECTIONS.length} koleksi)`,
    });
  } catch (e) {
    console.error(e);
    alert('Gagal mengambil data untuk backup. Pastikan Anda sudah login, lalu coba lagi.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Download Backup Semua Data (JSON)'; }
  }
}

export function initBackupEvents() {
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) btn.addEventListener('click', downloadBackupSemuaData);
}
