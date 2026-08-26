// ---------- State bersama antar modul (Firebase handles, cache data) ----------

export const state = {
  app: null,
  db: null,
  auth: null,
  currentDate: null,
  gudangUnsub: null,
  distUnsub: null,
  lokasiSet: new Set(),
  lastDistItems: [],
  authMode: 'login', // 'login' | 'register'
  appDataStarted: false, // supaya listener Firestore hanya dipasang sekali per sesi
};

export function setStatus(connected) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;
  if (connected) {
    dot.classList.remove('off');
    txt.textContent = 'Tersambung — data sinkron real-time';
  } else {
    dot.classList.add('off');
    txt.textContent = 'Tidak tersambung ke database';
  }
}
