// ---------- Koperasi Bahan Makanan — Update VA (saldo akhir Virtual Account per bank) ----------
// Data rahasia -- dua lapis proteksi:
// 1) Kunci password DI LAYAR (PASSWORD di bawah) -- ini cuma penghalang tampilan, siapa pun yang
//    buka source code bisa melihat nilainya. Diminta Pujha sebagai kunci cepat/mudah diingat.
// 2) Proteksi SUNGGUHAN ada di aturan Firestore (lihat README.md): hanya akun dengan email
//    rsehatindonesia@gmail.com yang diizinkan baca/tulis koleksi 'vaBalances' sama sekali -- staf
//    lain yang login ke web tetap ditolak server walau tahu password di atas.
import { doc, setDoc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatDate, formatRupiah, escapeHtml, isDateStrInRange, todayIso } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

const PASSWORD = 'koperasi2026'; // kunci tampilan saja -- lihat catatan proteksi di atas. Ganti di sini kapan saja kalau mau diubah.

export const BANKS = [
  { id: 'bsi', field: 'saldoBsi', label: 'BSI' },
  { id: 'mandiri', field: 'saldoMandiri', label: 'Mandiri' },
  { id: 'bri', field: 'saldoBri', label: 'BRI' },
  { id: 'bca', field: 'saldoBca', label: 'BCA' },
  { id: 'btn', field: 'saldoBtn', label: 'BTN' },
  { id: 'bni', field: 'saldoBni', label: 'BNI' },
];

function isUnlocked() {
  try { return sessionStorage.getItem('vaUnlocked') === '1'; } catch { return false; }
}

function setUnlocked() {
  try { sessionStorage.setItem('vaUnlocked', '1'); } catch { /* abaikan kalau storage diblok */ }
}

function applyLockUi() {
  const unlocked = isUnlocked();
  document.getElementById('vaLockScreen').classList.toggle('hidden', unlocked);
  document.getElementById('vaContent').classList.toggle('hidden', !unlocked);
}

function tryUnlock() {
  const input = document.getElementById('vaPasswordInput');
  const errEl = document.getElementById('vaLockError');
  if (input.value === PASSWORD) {
    setUnlocked();
    input.value = '';
    errEl.classList.add('hidden');
    applyLockUi();
  } else {
    errEl.classList.remove('hidden');
  }
}

export function renderVa(data) {
  const box = document.getElementById('vaBox');
  if (!data) {
    box.innerHTML = `<div class="no-data">Belum ada data saldo VA untuk tanggal ini.</div>`;
    document.getElementById('vaTotal').textContent = '–';
    return;
  }
  let total = 0;
  box.innerHTML = BANKS.map(b => {
    const v = data[b.field];
    const hasVal = typeof v === 'number';
    if (hasVal) total += v;
    return `
      <div class="va-bank-card">
        <div class="va-bank-label">${escapeHtml(b.label)}</div>
        <div class="va-bank-val">${hasVal ? formatRupiah(v) : `<span class="no-data no-data--inline">Belum ada data</span>`}</div>
      </div>`;
  }).join('');
  document.getElementById('vaTotal').textContent = formatRupiah(total);
  const metaEl = document.getElementById('vaMeta');
  metaEl.textContent = data.updatedBy ? `Terakhir diupdate oleh ${data.updatedBy}` : '';
}

let onVaChange = () => {};

export function watchVaDates(onChange) {
  if (onChange) onVaChange = onChange;
  onSnapshot(collection(state.db, 'vaBalances'), (qs) => {
    const dates = [];
    state.lastVaHistory = [];
    qs.forEach(d => { dates.push(d.id); state.lastVaHistory.push({ tanggal: d.id, ...d.data() }); });
    state.lastVaHistory.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
    const sel = document.getElementById('vaDateSelect');
    if (!sel) return;
    if (dates.length === 0) { sel.innerHTML = ''; renderVa(null); return; }
    dates.sort().reverse();
    const prevValue = sel.value;
    sel.innerHTML = dates.map(d => `<option value="${d}">${formatDate(d)}</option>`).join('');
    const nextDate = dates.includes(prevValue) ? prevValue : dates[0];
    sel.value = nextDate;
    watchSelectedVa(nextDate);
  }, (err) => {
    console.error('Gagal memuat daftar tanggal VA', err);
    const box = document.getElementById('vaBox');
    if (box) box.innerHTML = `<div class="no-data">Tidak bisa memuat data — akun Anda mungkin tidak punya akses ke halaman ini.</div>`;
  });
}

export function watchSelectedVa(date) {
  if (state.vaUnsub) state.vaUnsub();
  state.vaUnsub = onSnapshot(doc(state.db, 'vaBalances', date), (snap) => {
    renderVa(snap.exists() ? snap.data() : null);
    onVaChange();
  }, (err) => console.error('Gagal memuat saldo VA', err));
}

export async function saveVa() {
  const dateInput = document.getElementById('newVaDate').value;
  if (!dateInput) { alert('Pilih tanggal terlebih dahulu.'); return; }

  const entry = { updatedAt: Date.now(), updatedBy: state.currentUserEmail };
  BANKS.forEach(b => {
    const el = document.getElementById('vaInput_' + b.id);
    const v = el ? el.value : '';
    entry[b.field] = v === '' ? null : Number(v);
  });

  const btn = document.getElementById('btnSaveVa');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    await setDoc(doc(state.db, 'vaBalances', dateInput), entry);
    logActivity({
      action: 'ubah', modul: 'Koperasi - Update VA',
      ringkasan: `Update saldo VA tanggal ${formatDate(dateInput)}`,
    });
    document.getElementById('vaFormPanel').classList.remove('open');
    const sel = document.getElementById('vaDateSelect');
    if (![...sel.options].some(o => o.value === dateInput)) {
      const opt = document.createElement('option');
      opt.value = dateInput; opt.textContent = formatDate(dateInput);
      sel.insertBefore(opt, sel.firstChild);
    }
    sel.value = dateInput;
    watchSelectedVa(dateInput);
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan akun Anda punya akses ke data ini dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Saldo VA';
  }
}

export function downloadLaporanVa() {
  const dari = document.getElementById('vaFilterDari').value;
  const sampai = document.getElementById('vaFilterSampai').value;
  const rows = state.lastVaHistory.filter(r => isDateStrInRange(r.tanggal, dari, sampai));
  if (rows.length === 0) { alert('Tidak ada data riwayat saldo VA untuk rentang tanggal ini.'); return; }

  const headers = ['Tanggal', ...BANKS.map(b => `Saldo ${b.label}`), 'Total', 'Diupdate Oleh'];
  const csvRows = rows.map(r => {
    const total = BANKS.reduce((s, b) => s + (typeof r[b.field] === 'number' ? r[b.field] : 0), 0);
    return [formatDate(r.tanggal), ...BANKS.map(b => r[b.field] ?? ''), total, r.updatedBy || ''];
  });
  downloadCsv(`Laporan-Saldo-VA-${dateRangeFileTag(dari, sampai)}.csv`, headers, csvRows);
}

export function initVaEvents() {
  applyLockUi();
  document.getElementById('btnVaUnlock').addEventListener('click', tryUnlock);
  document.getElementById('vaPasswordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  document.getElementById('vaDateSelect').addEventListener('change', (e) => watchSelectedVa(e.target.value));
  document.getElementById('btnToggleVaForm').addEventListener('click', () => {
    document.getElementById('newVaDate').value = todayIso();
    const current = state.lastVaHistory.find(h => h.tanggal === document.getElementById('vaDateSelect').value);
    BANKS.forEach(b => {
      const el = document.getElementById('vaInput_' + b.id);
      el.value = (current && current[b.field] !== undefined && current[b.field] !== null) ? current[b.field] : '';
    });
    document.getElementById('vaFormPanel').classList.add('open');
  });
  document.getElementById('btnCancelVa').addEventListener('click', () => document.getElementById('vaFormPanel').classList.remove('open'));
  document.getElementById('btnSaveVa').addEventListener('click', saveVa);
  document.getElementById('btnDownloadVa').addEventListener('click', downloadLaporanVa);
}
