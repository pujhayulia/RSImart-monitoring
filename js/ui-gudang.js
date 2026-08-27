// ---------- Render & aksi: Stok Gudang RSI ----------
import { doc, setDoc, getDoc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { ICONS, PRODUK_NON_GALON, SEED_DATE, SEED_GUDANG } from './data.js';
import { formatDate, escapeHtml, isDateStrInRange } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

export function renderGudang(rekap) {
  const box = document.getElementById('gudangBox');
  const stokGrid = document.getElementById('stokProdukGrid');
  if (!rekap) {
    box.innerHTML = `<div class="no-data">Belum ada data stok untuk tanggal ini.</div>`;
    stokGrid.innerHTML = `<div class="no-data">Belum ada data.</div>`;
    document.getElementById('totalIsi').textContent = '–';
    document.getElementById('totalKosong').textContent = '–';
    document.getElementById('totalPeredaran').textContent = '–';
    return;
  }
  const hasData = rekap.isi !== null && rekap.isi !== undefined && rekap.kosong !== null && rekap.kosong !== undefined;
  let fillPct = 0;
  if (hasData) {
    const tot = (rekap.isi || 0) + (rekap.kosong || 0);
    fillPct = tot > 0 ? Math.round((rekap.isi / tot) * 100) : 0;
  }
  box.innerHTML = `
    <div class="jug-card jug-card--single">
      <div class="jug jug--lg"><div class="jug-fill" style="height:${hasData ? fillPct : 0}%;"></div></div>
      <div class="jug-info">
        <div class="loc-name">Air ARSI Galon 19L <span class="loc-badge">PUSAT</span></div>
        ${hasData ?
          `<div class="jug-stats"><span class="isi">Isi: ${rekap.isi} galon</span><span class="kosong">Kosong: ${rekap.kosong} galon</span></div>`
          : `<div class="no-data no-data--inline">Belum ada data</div>`}
        ${rekap.updatedBy ? `<div class="meta">Terakhir diupdate oleh ${escapeHtml(rekap.updatedBy)}</div>` : ''}
      </div>
    </div>`;
  document.getElementById('totalIsi').textContent = (rekap.isi ?? '–') + ' galon';
  document.getElementById('totalKosong').textContent = (rekap.kosong ?? '–') + ' galon';
  document.getElementById('totalPeredaran').textContent = (rekap.peredaran ?? '–') + ' galon';

  const stokProduk = rekap.stokProduk || {};
  stokGrid.innerHTML = PRODUK_NON_GALON.map(p => {
    const qty = stokProduk[p.id];
    const hasQty = qty !== null && qty !== undefined && qty !== '';
    return `
      <div class="stok-mini-card">
        <div class="stok-mini-icon">${ICONS[p.icon]}</div>
        <div>
          <div class="stok-mini-name">${p.name}</div>
          <div class="stok-mini-size">${p.size}</div>
          <div class="stok-mini-qty">${hasQty ? `${qty} ${p.satuan}` : `<span class="no-data no-data--inline">Belum ada data</span>`}</div>
        </div>
      </div>`;
  }).join('');
}

export function renderStokProdukFormInputs(existingStok) {
  const wrap = document.getElementById('stokProdukFormGrid');
  wrap.innerHTML = PRODUK_NON_GALON.map(p => {
    const cur = (existingStok && existingStok[p.id] !== undefined && existingStok[p.id] !== null) ? existingStok[p.id] : '';
    return `
    <div class="form-field">
      <label for="stokProduk_${p.id}">${p.name} — ${p.size} (${p.satuan})</label>
      <input type="number" id="stokProduk_${p.id}" value="${cur}" placeholder="-">
    </div>`;
  }).join('');
}

export async function ensureSeedGudang() {
  const ref = doc(state.db, 'rekap', SEED_DATE);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, SEED_GUDANG);
  }
}

let onGudangChange = () => {};

export function watchGudangDates(onChange) {
  if (onChange) onGudangChange = onChange;
  onSnapshot(collection(state.db, 'rekap'), (qs) => {
    const dates = [];
    state.allGudangHistory = [];
    qs.forEach(d => { dates.push(d.id); state.allGudangHistory.push({ tanggal: d.id, ...d.data() }); });
    state.allGudangHistory.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
    if (dates.length === 0) return;
    dates.sort().reverse();
    const sel = document.getElementById('rekapDateSelect');
    const prevValue = sel.value;
    sel.innerHTML = dates.map(d => `<option value="${d}">${formatDate(d)}</option>`).join('');
    if (dates.includes(prevValue)) {
      sel.value = prevValue;
      state.currentDate = prevValue;
    } else {
      state.currentDate = dates[0];
      sel.value = state.currentDate;
    }
    watchSelectedGudang(state.currentDate);
  }, (err) => console.error('Gagal memuat daftar tanggal', err));
}

export function watchSelectedGudang(date) {
  if (state.gudangUnsub) state.gudangUnsub();
  state.gudangUnsub = onSnapshot(doc(state.db, 'rekap', date), (snap) => {
    const data = snap.exists() ? snap.data() : null;
    state.currentGudangData = data;
    renderGudang(data);
    onGudangChange();
  }, (err) => console.error('Gagal memuat stok gudang', err));
}

export async function saveGudang() {
  const dateInput = document.getElementById('newRekapDate').value;
  const isi = document.getElementById('gudangIsi').value;
  const kosong = document.getElementById('gudangKosong').value;
  const peredaran = document.getElementById('gudangPeredaran').value;
  if (!dateInput) { alert('Pilih tanggal terlebih dahulu.'); return; }

  const stokProduk = {};
  PRODUK_NON_GALON.forEach(p => {
    const el = document.getElementById('stokProduk_' + p.id);
    const v = el ? el.value : '';
    stokProduk[p.id] = v === '' ? null : Number(v);
  });

  const rekap = {
    isi: isi === '' ? null : Number(isi),
    kosong: kosong === '' ? null : Number(kosong),
    peredaran: peredaran === '' ? null : Number(peredaran),
    stokProduk,
    updatedAt: Date.now(),
    updatedBy: state.currentUserEmail,
  };
  const btn = document.getElementById('btnSaveRekap');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    await setDoc(doc(state.db, 'rekap', dateInput), rekap);
    logActivity({
      action: 'ubah',
      modul: 'Stok Gudang RSI',
      ringkasan: `Update stok gudang tanggal ${formatDate(dateInput)}: isi ${rekap.isi ?? '-'} galon, kosong ${rekap.kosong ?? '-'} galon`,
    });
    document.getElementById('formPanel').classList.remove('open');
    state.currentDate = dateInput;
    watchSelectedGudang(dateInput);
    const sel = document.getElementById('rekapDateSelect');
    if (![...sel.options].some(o => o.value === dateInput)) {
      const opt = document.createElement('option');
      opt.value = dateInput; opt.textContent = formatDate(dateInput);
      sel.insertBefore(opt, sel.firstChild);
    }
    sel.value = dateInput;
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Stok Gudang';
  }
}

export function downloadLaporanGudang() {
  const dari = document.getElementById('gudangFilterDari').value;
  const sampai = document.getElementById('gudangFilterSampai').value;
  const rows = state.allGudangHistory.filter(r => isDateStrInRange(r.tanggal, dari, sampai));

  if (rows.length === 0) {
    alert('Tidak ada data riwayat stok gudang untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal', 'Stok Isi Galon', 'Stok Kosong Galon', 'Peredaran Galon',
    ...PRODUK_NON_GALON.map(p => `${p.name} - ${p.size} (${p.satuan})`), 'Diupdate Oleh'];

  const csvRows = rows.map(r => [
    formatDate(r.tanggal), r.isi ?? '', r.kosong ?? '', r.peredaran ?? '',
    ...PRODUK_NON_GALON.map(p => (r.stokProduk && r.stokProduk[p.id] != null) ? r.stokProduk[p.id] : ''),
    r.updatedBy || '',
  ]);

  const latest = rows[0]; // allGudangHistory sudah terurut terbaru dulu
  csvRows.push([]);
  csvRows.push(['RINGKASAN (data terbaru dalam rentang, ' + formatDate(latest.tanggal) + ')']);
  csvRows.push(['Stok Isi Galon', latest.isi ?? '-']);
  csvRows.push(['Stok Kosong Galon', latest.kosong ?? '-']);
  csvRows.push(['Jumlah Peredaran Galon', latest.peredaran ?? '-']);

  downloadCsv(`Laporan-Stok-Gudang-RSI-${dateRangeFileTag(dari, sampai)}.csv`, headers, csvRows);
}

export function initGudangReportEvents() {
  document.getElementById('btnDownloadGudang').addEventListener('click', downloadLaporanGudang);
}
