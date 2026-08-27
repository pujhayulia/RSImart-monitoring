// ---------- State bersama antar modul (Firebase handles, cache data) ----------

export const state = {
  app: null,
  db: null,
  auth: null,
  currentUserEmail: '',
  activeModule: null, // 'rsi' | 'koperasi' | null (null = layar pilih modul)
  currentDate: null,
  currentGudangData: null,
  allGudangHistory: [], // seluruh riwayat rekap (semua tanggal) — dipakai untuk Laporan Stok Gudang
  gudangUnsub: null,
  distUnsub: null,
  lokasiSet: new Set(),
  lastDistItems: [],
  pembelianUnsub: null,
  lastPembelianItems: [],
  distribusiSppgUnsub: null,
  lastDistribusiSppgItems: [],
  activityLogUnsub: null,
  lastActivityLog: [],
  authMode: 'login', // 'login' | 'register'
  appDataStarted: false, // supaya listener Firestore hanya dipasang sekali per sesi
};

export function setStatus(connected) {
  const dots = document.querySelectorAll('.js-status-dot');
  const texts = document.querySelectorAll('.js-status-text');
  if (!dots.length || !texts.length) return;
  const label = connected ? 'Tersambung — data sinkron real-time' : 'Tidak tersambung ke database';
  dots.forEach(dot => dot.classList.toggle('off', !connected));
  texts.forEach(txt => { txt.textContent = label; });
}
