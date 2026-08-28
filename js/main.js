// ---------- Titik masuk aplikasi: inisialisasi Firebase & wiring UI ----------
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import { state, setStatus } from './state.js';
import { todayIso, formatRupiah, monthRange } from './utils.js';
import { initRouter } from './router.js';
import { initAuthUI, watchAuthState } from './auth.js';
import { renderProdukGrid, initKatalogEvents } from './ui-katalog.js';
import {
  ensureSeedGudang, watchGudangDates, watchSelectedGudang, saveGudang, renderStokProdukFormInputs,
  initGudangReportEvents
} from './ui-gudang.js';
import { ensureSeedLokasi, watchLokasi } from './ui-lokasi.js';
import { initProdukSelects, watchDistribusi, saveDistribusi, renderDistLog } from './ui-distribusi.js';
import { renderKeuangan, initKeuanganReportEvents } from './ui-keuangan.js';
import { renderBeranda } from './ui-beranda.js';
import { watchPembelian, initPembelianEvents, refreshPoOptions } from './ui-pembelian.js';
import { watchDistribusiSppg, initDistribusiSppgEvents, prefillFromPo } from './ui-distribusi-sppg.js';
import { watchPoSppg, initPoSppgEvents } from './ui-po-sppg.js';
import { watchBiayaOperasional, initBiayaOperasionalEvents } from './ui-biaya-operasional.js';
import { initBackupEvents } from './ui-backup.js';
import { renderBerandaKoperasi, initBerandaKoperasiEvents } from './ui-beranda-koperasi.js';
import {
  computeKoperasiKeuangan, renderLaporanKeuanganKoperasi, initLaporanKeuanganKoperasiEvents
} from './ui-laporan-keuangan-koperasi.js';
import { watchActivityLog, initActivityLogEvents } from './activity-log.js';

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

function renderLandingStats() {
  const stokEl = document.getElementById('landingStokGalon');
  if (!stokEl) return;
  const rekap = state.currentGudangData;
  stokEl.textContent = (rekap && rekap.isi !== null && rekap.isi !== undefined) ? `${rekap.isi} galon` : '–';

  const { dari, sampai } = monthRange();
  const data = computeKoperasiKeuangan(dari, sampai);
  document.getElementById('landingPembelianBulanIni').textContent = formatRupiah(data.totalPengeluaran);
  document.getElementById('landingDistribusiBulanIni').textContent = formatRupiah(data.totalPemasukan);
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
  initGudangReportEvents();
  initKeuanganReportEvents();
  initPoSppgEvents();
  initBiayaOperasionalEvents();
  initPembelianEvents();
  initDistribusiSppgEvents();
  initBerandaKoperasiEvents();
  initLaporanKeuanganKoperasiEvents();
  initActivityLogEvents();
  initBackupEvents();
}

function onGudangChange() {
  renderBeranda();
  renderLandingStats();
}

function onDistribusiChange() {
  renderDistLog();
  renderKeuangan();
  renderBeranda();
}

function onKoperasiDataChange() {
  renderBerandaKoperasi();
  renderLaporanKeuanganKoperasi();
  renderLandingStats();
  refreshPoOptions();
}

async function startAppData() {
  if (state.appDataStarted) return;
  state.appDataStarted = true;
  try {
    await ensureSeedGudang();
    await ensureSeedLokasi();
    watchGudangDates(onGudangChange);
    watchLokasi();
    watchDistribusi(onDistribusiChange);
    watchPoSppg(onKoperasiDataChange);
    watchBiayaOperasional(onKoperasiDataChange);
    watchPembelian(onKoperasiDataChange);
    watchDistribusiSppg(onKoperasiDataChange);
    watchActivityLog();
  } catch (e) {
    console.error('Gagal inisialisasi data', e);
  }
}

async function init() {
  renderProdukGrid();
  initKatalogEvents();
  initProdukSelects();
  initEvents();
  initRouter((module, page) => {
    if (module === 'rsi' && page === 'beranda') renderBeranda();
    if (module === 'koperasi' && page === 'beranda') renderBerandaKoperasi();
    if (module === 'koperasi' && page === 'laporankeuangan') renderLaporanKeuanganKoperasi();
    if (module === 'koperasi' && page === 'distribusisppg' && state.poPrefill) {
      prefillFromPo(state.poPrefill);
      state.poPrefill = null;
    }
  });
  document.getElementById('distTanggalPesan').value = todayIso();
  document.getElementById('distTanggalKirim').value = todayIso();
  document.getElementById('sppgTanggalKirim').value = todayIso();
  document.getElementById('poTanggal').value = todayIso();
  document.getElementById('biayaOpTanggal').value = todayIso();

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
