// ---------- Riwayat Aktivitas — mencatat siapa melakukan apa, transparan untuk seluruh tim ----------
// Log ini terpisah dari data operasional (rekap/pengiriman/pembelian/dst).
// Setiap tambah/ubah/hapus data penting di modul lain memanggil logActivity()
// di sini, supaya tim bisa lihat riwayatnya di halaman "Riwayat Aktivitas" —
// termasuk ringkasan data yang sudah dihapus (datanya sendiri hilang, tapi
// jejaknya tetap ada di log ini).
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatTimestamp, isTimestampInRange, escapeHtml } from './utils.js';

const ACTION_LABEL = { tambah: 'Tambah', ubah: 'Ubah', hapus: 'Hapus' };

/** Daftar modul yang benar-benar dipakai logActivity() di seluruh situs — dipakai untuk isi dropdown filter. */
export const ACTIVITY_MODULES = ['Stok Gudang RSI', 'Distribusi', 'Koperasi - PO SPPG', 'Koperasi - Pembelian', 'Koperasi - Distribusi SPPG', 'Koperasi - Biaya Operasional'];

/** @param {{action:'tambah'|'ubah'|'hapus', modul:string, ringkasan:string}} entry */
export async function logActivity(entry) {
  try {
    await addDoc(collection(state.db, 'activityLog'), {
      action: entry.action,
      modul: entry.modul,
      ringkasan: entry.ringkasan,
      by: state.currentUserEmail || 'tidak diketahui',
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    // Jangan sampai kegagalan mencatat log menggagalkan aksi utama (simpan/hapus data).
    console.error('Gagal mencatat riwayat aktivitas', e);
  }
}

export function watchActivityLog(onChange) {
  const logEl = document.getElementById('aktivitasLog');
  if (!logEl) return;
  logEl.innerHTML = `<div class="empty-state">Memuat riwayat aktivitas...</div>`;
  const q = query(collection(state.db, 'activityLog'), orderBy('createdAt', 'desc'), limit(300));
  if (state.activityLogUnsub) state.activityLogUnsub();
  state.activityLogUnsub = onSnapshot(q, (qs) => {
    state.lastActivityLog = [];
    qs.forEach(d => state.lastActivityLog.push({ id: d.id, ...d.data() }));
    renderActivityLog();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat riwayat aktivitas.</div>`;
  });
}

function filteredActivityLog() {
  const modulEl = document.getElementById('aktivitasFilterModul');
  const aksiEl = document.getElementById('aktivitasFilterAksi');
  const olehEl = document.getElementById('aktivitasFilterOleh');
  const dariEl = document.getElementById('aktivitasFilterDari');
  const sampaiEl = document.getElementById('aktivitasFilterSampai');
  if (!modulEl) return state.lastActivityLog;

  const modul = modulEl.value;
  const aksi = aksiEl.value;
  const oleh = olehEl.value.trim().toLowerCase();
  const dari = dariEl.value;
  const sampai = sampaiEl.value;

  return state.lastActivityLog.filter(it => {
    if (modul !== 'all' && it.modul !== modul) return false;
    if (aksi !== 'all' && it.action !== aksi) return false;
    if (oleh && !(it.by || '').toLowerCase().includes(oleh)) return false;
    if ((dari || sampai) && !isTimestampInRange(it.createdAt, dari, sampai)) return false;
    return true;
  });
}

export function renderActivityLog() {
  const logEl = document.getElementById('aktivitasLog');
  if (!logEl) return;
  const items = filteredActivityLog();
  if (!items || items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Tidak ada aktivitas yang cocok dengan filter ini.</div>`;
    return;
  }
  logEl.innerHTML = items.map(it => `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.ringkasan || '-')}</b>
        <div class="meta">${escapeHtml(it.modul || '-')} · oleh ${escapeHtml(it.by || '-')}</div>
        <div class="meta">${formatTimestamp(it.createdAt)}</div>
      </div>
      <div class="right">
        <span class="activity-badge activity-badge--${it.action}">${ACTION_LABEL[it.action] || it.action}</span>
      </div>
    </div>
  `).join('');
}

export function initActivityLogEvents() {
  const modulSel = document.getElementById('aktivitasFilterModul');
  if (!modulSel) return;
  modulSel.innerHTML = '<option value="all">Semua Modul</option>' +
    ACTIVITY_MODULES.map(m => `<option value="${m}">${m}</option>`).join('');

  ['aktivitasFilterModul', 'aktivitasFilterAksi', 'aktivitasFilterDari', 'aktivitasFilterSampai'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderActivityLog);
  });
  document.getElementById('aktivitasFilterOleh').addEventListener('input', renderActivityLog);
  document.getElementById('btnAktivitasFilterReset').addEventListener('click', () => {
    document.getElementById('aktivitasFilterModul').value = 'all';
    document.getElementById('aktivitasFilterAksi').value = 'all';
    document.getElementById('aktivitasFilterOleh').value = '';
    document.getElementById('aktivitasFilterDari').value = '';
    document.getElementById('aktivitasFilterSampai').value = '';
    renderActivityLog();
  });
}
