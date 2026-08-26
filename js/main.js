// ---------- Titik masuk aplikasi: inisialisasi Firebase & wiring UI ----------
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import { state, setStatus } from './state.js';
import { todayIso } from './utils.js';
import { initAuthUI, watchAuthState } from './auth.js';
import { renderProdukGrid } from './ui-katalog.js';
import {
  ensureSeedGudang, watchGudangDates, watchSelectedGudang, saveGudang, renderStokProdukFormInputs
} from './ui-gudang.js';
import { ensureSeedLokasi, watchLokasi } from './ui-lokasi.js';
import { initProdukSelects, watchDistribusi, saveDistribusi, renderDistLog } from './ui-distribusi.js';
import { renderKeuangan } from './ui-keuangan.js';

const configLooksEmpty = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('GANTI_DENGAN');

function showConfigWarning() {
  // Firebase belum siap, jadi layar login tidak akan bisa berfungsi —
  // langsung tampilkan halaman utama dengan peringatan konfigurasi.
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  const warn = document.createElement('div');
  warn.className = 'config-warning';
  warn.innerHTML = '⚠️ <b>Firebase belum dikonfigurasi.</b> Buka file <code>js/firebase-config.js</code> dan isi dengan konfigurasi project Firebase Anda (lihat README.md).';
  document.body.insertBefore(warn, document.getElementById('mainApp'));
  setStatus(false);
}

function initEvents() {
  document.getElementById('btnToggleForm').addEventListener('click', () => {
    const panel = document.getElementById('formPanel');
    const isOpen = panel.classList.toggle('open');
    if (isOpen) {
      document.getElementById('newRekapDate').value = todayIso();
      document.getElementById('gudangIsi').value = '';
      document.getElementById('gudangKosong').value = '';
      document.getElementById('gudangPeredaran').value = '';
      renderStokProdukFormInputs(null);
    }
  });
  document.getElementById('btnCancelRekap').addEventListener('click', () => {
    document.getElementById('formPanel').classList.remove('open');
  });
  document.getElementById('btnSaveRekap').addEventListener('click', saveGudang);
  document.getElementById('rekapDateSelect').addEventListener('change', (e) => {
    state.currentDate = e.target.value;
    watchSelectedGudang(state.currentDate);
  });
  document.getElementById('btnSaveDist').addEventListener('click', saveDistribusi);
}

function onDistribusiChange() {
  renderDistLog();
  renderKeuangan();
}

async function startAppData() {
  if (state.appDataStarted) return;
  state.appDataStarted = true;
  try {
    await ensureSeedGudang();
    await ensureSeedLokasi();
    watchGudangDates();
    watchLokasi();
    watchDistribusi(onDistribusiChange);
  } catch (e) {
    console.error('Gagal inisialisasi data', e);
  }
}

async function init() {
  renderProdukGrid();
  initProdukSelects();
  initEvents();
  document.getElementById('distTanggalPesan').value = todayIso();
  document.getElementById('distTanggalKirim').value = todayIso();

  if (configLooksEmpty) {
    showConfigWarning();
    return;
  }

  try {
    state.app = initializeApp(firebaseConfig);
    state.db = getFirestore(state.app);
    state.auth = getAuth(state.app);

    initAuthUI();

    watchAuthState({
      onSignedIn: () => { setStatus(true); startAppData(); },
      onSignedOut: () => setStatus(false),
    });
  } catch (e) {
    console.error('Gagal terhubung ke Firebase', e);
    setStatus(false);
    alert('Gagal terhubung ke Firebase. Periksa kembali js/firebase-config.js dan koneksi internet Anda.');
  }
}

document.addEventListener('DOMContentLoaded', init);
