// ---------- Router berbasis hash, sadar-modul ----------
// Dua modul terpisah (RSI & Koperasi Bahan Makanan) dengan sidebar & halaman
// masing-masing, plus satu halaman bersama ("Riwayat Aktivitas") yang bisa
// diakses dari modul mana pun.
import { state } from './state.js';

export const MODULES = {
  rsi: {
    label: 'Web RSI',
    pages: {
      beranda: 'Beranda',
      katalog: 'Katalog Produk',
      gudang: 'Stok Gudang RSI',
      distribusi: 'Distribusi & Pengiriman',
      keuangan: 'Rekap Keuangan',
    },
  },
  koperasi: {
    label: 'Koperasi Bahan Makanan',
    pages: {
      beranda: 'Beranda Koperasi',
      posppg: 'PO dari SPPG',
      pembelian: 'Pembelian Bahan Makanan',
      distribusisppg: 'Distribusi ke SPPG',
      biayaoperasional: 'Biaya Operasional',
      laporankeuangan: 'Laporan Keuangan Koperasi',
    },
  },
};
const SHARED_PAGES = { aktivitas: 'Riwayat Aktivitas' };
const STORAGE_KEY = 'rsiActiveModule';

function resolveActiveModule() {
  if (state.activeModule && MODULES[state.activeModule]) return state.activeModule;
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && MODULES[saved] ? saved : null;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw === 'aktivitas') {
    const module = resolveActiveModule();
    return module ? { module, page: 'aktivitas' } : null;
  }
  const [mod, page] = raw.split('/');
  if (MODULES[mod] && MODULES[mod].pages[page]) return { module: mod, page };
  return null;
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
}

export function navigateTo(module, page) {
  location.hash = `#/${module}/${page}`;
}

export function navigateToActivity() {
  location.hash = '#/aktivitas';
}

export function gantiModul() {
  state.activeModule = null;
  localStorage.removeItem(STORAGE_KEY);
  location.hash = '';
  render();
}

let onNavigateCb = () => {};

function pageTitleFor(module, page) {
  if (page === 'aktivitas') return SHARED_PAGES.aktivitas;
  return (MODULES[module] && MODULES[module].pages[page]) || '';
}

function render() {
  let parsed = parseHash();
  if (!parsed) {
    const module = resolveActiveModule();
    parsed = module ? { module, page: 'beranda' } : null;
  }

  const moduleSelectEl = document.getElementById('moduleSelect');
  const appShellEl = document.getElementById('appShell');

  if (!parsed) {
    state.activeModule = null;
    moduleSelectEl.classList.remove('hidden');
    appShellEl.classList.add('hidden');
    closeMobileSidebar();
    document.title = 'Pilih Modul — Yayasan Rumah Sehat Indonesia';
    return;
  }

  const { module, page } = parsed;
  state.activeModule = module;
  localStorage.setItem(STORAGE_KEY, module);

  moduleSelectEl.classList.add('hidden');
  appShellEl.classList.remove('hidden');

  document.querySelectorAll('.sidebar-nav').forEach(el => {
    el.classList.toggle('hidden', el.dataset.module !== module);
  });
  document.querySelectorAll('.page').forEach(el => {
    const matchesModule = el.dataset.module === module || el.dataset.module === 'shared';
    el.classList.toggle('active', matchesModule && el.dataset.page === page);
  });
  document.querySelectorAll('.sidebar-link').forEach(el => {
    const matchesModule = el.dataset.module === module || el.dataset.module === 'shared';
    el.classList.toggle('active', matchesModule && el.dataset.page === page);
  });
  document.querySelectorAll('.js-module-label').forEach(el => {
    el.textContent = MODULES[module].label;
  });

  const title = pageTitleFor(module, page);
  document.getElementById('topbarTitle').textContent = title;
  document.title = `${title} — Yayasan Rumah Sehat Indonesia`;
  closeMobileSidebar();
  window.scrollTo(0, 0);
  onNavigateCb(module, page);
}

export function initRouter(onNavigate) {
  onNavigateCb = onNavigate;
  document.getElementById('btnMenuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarBackdrop').classList.toggle('open');
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', closeMobileSidebar);
  document.querySelectorAll('.js-ganti-modul').forEach(btn => {
    btn.addEventListener('click', (e) => { e.preventDefault(); gantiModul(); });
  });
  document.querySelectorAll('.js-module-pick').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.module, 'beranda'));
  });
  document.querySelectorAll('.js-quicknav').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.module, btn.dataset.page));
  });

  window.addEventListener('hashchange', render);
  render();
}
