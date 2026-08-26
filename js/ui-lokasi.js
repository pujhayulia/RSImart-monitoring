// ---------- Lokasi (tujuan pengiriman) — dinamis, tersimpan di Firestore ----------
import { collection, addDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { SEED_LOKASI } from './data.js';
import { escapeHtml } from './utils.js';

export async function ensureSeedLokasi() {
  const snap = await new Promise((resolve) => {
    const unsub = onSnapshot(collection(state.db, 'lokasi'), (qs) => { unsub(); resolve(qs); });
  });
  if (snap.empty) {
    for (const nama of SEED_LOKASI) {
      await addDoc(collection(state.db, 'lokasi'), { nama, createdAt: Date.now() });
    }
  }
}

export function watchLokasi() {
  onSnapshot(collection(state.db, 'lokasi'), (qs) => {
    state.lokasiSet = new Set();
    const names = [];
    qs.forEach(d => {
      const nama = d.data().nama;
      if (nama && !state.lokasiSet.has(nama.toLowerCase())) {
        state.lokasiSet.add(nama.toLowerCase());
        names.push(nama);
      }
    });
    names.sort((a, b) => a.localeCompare(b));
    document.getElementById('lokasiList').innerHTML = names.map(l => `<option value="${escapeHtml(l)}">`).join('');
  }, (err) => console.error('Gagal memuat lokasi', err));
}

export async function ensureLokasiTersimpan(nama) {
  const trimmed = nama.trim();
  if (!trimmed) return;
  if (state.lokasiSet.has(trimmed.toLowerCase())) return;
  try {
    await addDoc(collection(state.db, 'lokasi'), { nama: trimmed, createdAt: Date.now() });
  } catch (e) {
    console.error('Gagal menyimpan lokasi baru', e);
  }
}
