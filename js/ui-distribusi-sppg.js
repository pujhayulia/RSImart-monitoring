// ---------- Koperasi Bahan Makanan — Sub-bagian 2: Distribusi/penjualan ke SPPG ----------
// Satu NOTA pengiriman = satu dokumen di collection "distribusiSppg", berisi
// array `items` (bisa banyak barang dalam satu nota). Ini berbeda dari modul
// Pembelian, yang tetap satu barang = satu dokumen.
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { KOPERASI_INFO } from './data.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, escapeHtml, todayIso, monthRange } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';
import { printReport } from './print-report.js';
import { markPoTerkirim } from './ui-po-sppg.js';

const LOGO_URL = 'assets/invoice/logo-koperasi.png';
const STEMPEL_URL = 'assets/invoice/stempel-koperasi.png';
const TTD_URL = 'assets/invoice/ttd-koperasi.jpg';
const TTD_MARGI_URL = 'assets/invoice/ttd-margi.jpg';

/** Tanda tangan asli per nama pengirim, dipakai di kolom "Pengirim" Surat Jalan — kalau namanya tidak ada di sini, kolomnya dikosongkan untuk ditandatangani manual. Stempel koperasi cuma dipasangkan ke Ghufron karena dialah penanda tangan resminya. */
const TTD_PENGIRIM = {
  [KOPERASI_INFO.penandaTangan.toLowerCase()]: { ttd: TTD_URL, stempel: STEMPEL_URL },
  'pak margi': { ttd: TTD_MARGI_URL, stempel: null },
};

// Kata kunci bahan yang dipisah ke pengirim lain (Ghufron/Margi): beras, telur, minyak, ayam, daging,
// tahu/tempe, dan ikan. Sayur-sayuran TIDAK termasuk — selalu tetap kiriman Farhan. Dicek sebagai substring,
// jadi tidak peduli huruf besar/kecil maupun variasi penulisan ("Telor Puyuh", "Ayam Fillet", "Daging Sapi",
// "Ikan Dori Fillet", dst tetap kena).
const KATEGORI_NONKERING_KEYWORDS = [
  'beras', 'telur', 'telor', 'minyak',
  'ayam', 'daging', 'sapi',
  'tahu', 'tempe',
  'ikan', 'dori', 'patin', 'lele',
];

function isBahanKering(namaBarang) {
  const n = (namaBarang || '').toLowerCase();
  return !KATEGORI_NONKERING_KEYWORDS.some(kw => n.includes(kw));
}

/**
 * Pengirim default satu baris barang, berdasarkan kategori bahan — sama untuk SPPG manapun
 * (Farhan, Pak Margi, Ghufron ketiganya bisa dipakai ke tujuan mana saja, tidak dibatasi per SPPG):
 * - Beras, telur, minyak, ayam, daging, tahu/tempe, ikan -> Ghufron (bisa diganti manual di form kalau
 *   ternyata Pak Margi yang kirim).
 * - Sayur-sayuran & sisanya -> Farhan.
 */
function defaultPengirimUntuk(namaBarang) {
  return isBahanKering(namaBarang) ? 'Farhan' : KOPERASI_INFO.penandaTangan;
}

/** Kelompokkan barang satu nota per pengirim default-nya — dipakai untuk pecah Surat Jalan otomatis. */
function kelompokkanPerPengirim(nota) {
  const groups = new Map();
  (nota.items || []).forEach(it => {
    const pengirim = defaultPengirimUntuk(it.namaBarang);
    if (!groups.has(pengirim)) groups.set(pengirim, []);
    groups.get(pengirim).push(it);
  });
  return Array.from(groups.entries()).map(([pengirim, items]) => ({ pengirim, items }));
}

/** "Dapur SPPG Sudimara Jaya" -> "Dapur_SPPG_Sudimara_Jaya" — dipakai untuk nama file unduhan (sama seperti di ui-po-sppg.js, sengaja tidak diimpor supaya kedua modul tidak saling bergantung). */
function slugifyTujuan(tujuan) {
  return (tujuan || 'SPPG').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
}

/** "2026-08-24" -> "24Agu2026" — dipakai untuk nama file unduhan. */
function fileDateTag(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d}${bulan[parseInt(m, 10) - 1]}${y}`;
}

let rowCounter = 0;
let editingId = null;
let linkedPoId = null; // id PO (poSppg) yang sedang dibuatkan nota ini, kalau datang dari alur "Buat Nota Pengiriman"
let suratJalanExpandId = null; // nota yang sedang dibuka form "Nama Pengirim"-nya sebelum cetak Surat Jalan

function itemRowHtml(rowId) {
  return `
    <div class="nota-item-row" data-rowid="${rowId}">
      <input class="nir-nama" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga satuan jual (opsional)">
        <button type="button" class="nir-remove" data-rowid="${rowId}" title="Hapus baris ini">✕</button>
      </div>
    </div>`;
}

function addItemRow(prefill) {
  rowCounter += 1;
  const wrap = document.getElementById('sppgItemRows');
  wrap.insertAdjacentHTML('beforeend', itemRowHtml(rowCounter));
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowCounter}"]`);
  row.querySelector('.nir-remove').addEventListener('click', () => removeItemRow(rowCounter));
  if (prefill) {
    row.querySelector('.nir-nama').value = prefill.namaBarang || '';
    row.querySelector('.nir-jumlah').value = prefill.jumlah ?? '';
    row.querySelector('.nir-satuan').value = prefill.satuan || '';
    row.querySelector('.nir-harga').value = prefill.hargaJual ?? '';
  }
}

function removeItemRow(rowId) {
  const wrap = document.getElementById('sppgItemRows');
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowId}"]`);
  if (row) row.remove();
  if (wrap.children.length === 0) addItemRow();
}

function resetItemRows() {
  document.getElementById('sppgItemRows').innerHTML = '';
  rowCounter = 0;
  addItemRow();
}

function readItemRows() {
  const rows = document.querySelectorAll('#sppgItemRows .nota-item-row');
  const items = [];
  rows.forEach(row => {
    const namaBarang = row.querySelector('.nir-nama').value.trim();
    const jumlah = row.querySelector('.nir-jumlah').value;
    const satuan = row.querySelector('.nir-satuan').value.trim();
    const harga = row.querySelector('.nir-harga').value;
    if (!namaBarang && !jumlah && !satuan && !harga) return; // baris kosong, lewati
    items.push({
      namaBarang,
      jumlah: jumlah === '' ? null : Number(jumlah),
      satuan,
      hargaJual: harga === '' ? null : Number(harga),
    });
  });
  return items;
}

export function watchDistribusiSppg(onChange) {
  const logEl = document.getElementById('sppgLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data distribusi...</div>`;
  const q = query(collection(state.db, 'distribusiSppg'), orderBy('createdAt', 'desc'), limit(300));
  if (state.distribusiSppgUnsub) state.distribusiSppgUnsub();
  state.distribusiSppgUnsub = onSnapshot(q, (qs) => {
    state.lastDistribusiSppgItems = [];
    qs.forEach(d => state.lastDistribusiSppgItems.push({ id: d.id, ...d.data() }));
    renderDistribusiSppg();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data distribusi ke SPPG.</div>`;
  });
}

/** Nota yang tanggalKirim-nya masuk rentang dari/sampai (boleh kosong = tak terbatas). Diekspor supaya bisa dipakai ulang oleh Laporan Keuangan Koperasi. */
export function notaInRange(dari, sampai) {
  if (!dari && !sampai) return state.lastDistribusiSppgItems;
  return state.lastDistribusiSppgItems.filter(nota => isDateStrInRange(nota.tanggalKirim, dari, sampai));
}

function filteredNota() {
  const dari = document.getElementById('sppgFilterDari').value;
  const sampai = document.getElementById('sppgFilterSampai').value;
  return notaInRange(dari, sampai);
}

/** Kumpulkan/flatten semua item dari semua nota yang diberikan — dipakai untuk total, bukan menghitung jumlah nota. */
export function flattenItems(notaList) {
  const flat = [];
  notaList.forEach(nota => {
    (nota.items || []).forEach(item => flat.push(item));
  });
  return flat;
}

/** Nilai satu baris barang (harga satuan x jumlah) — null kalau harga belum diisi. Diekspor untuk dipakai ulang oleh Laporan Keuangan Koperasi. */
export function itemNilai(it) {
  if (typeof it.hargaJual !== 'number') return null;
  const jumlah = typeof it.jumlah === 'number' ? it.jumlah : 0;
  return it.hargaJual * jumlah;
}

/** Total nilai & jumlah barang dalam rentang tanggal (kosongkan dari/sampai untuk semua data) — dipakai di Beranda Koperasi. */
export function computeDistribusiSppgSummary(dari, sampai) {
  const items = flattenItems(notaInRange(dari, sampai));
  let totalNilai = 0;
  items.forEach(it => { totalNilai += itemNilai(it) || 0; });
  return { totalNilai, jumlahItem: items.length };
}

/** Total nilai satu nota (jumlah semua baris barang x harga satuannya). Diekspor untuk dipakai ulang oleh Laporan Keuangan Koperasi. */
export function notaTotalNilai(nota) {
  return (nota.items || []).reduce((sum, it) => sum + (itemNilai(it) || 0), 0);
}

function nextSuratJalanNomor(year) {
  const prefix = `SJ/${year}/`;
  let max = 0;
  state.lastDistribusiSppgItems.forEach(nota => {
    if (nota.suratJalanNomor && nota.suratJalanNomor.startsWith(prefix)) {
      const n = parseInt(nota.suratJalanNomor.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function suratJalanHeadCompanyHtml() {
  return `
    <div class="invoice-head-company">
      <img class="invoice-logo" src="${LOGO_URL}" alt="Logo ${escapeHtml(KOPERASI_INFO.namaSingkat)}">
      <div>
        <b>${escapeHtml(KOPERASI_INFO.nama.toUpperCase())}</b>
        ${KOPERASI_INFO.alamatBaris.map(line => `<div class="addr">${escapeHtml(line)}</div>`).join('')}
      </div>
    </div>`;
}

// Nama-nama yang biasa mengantar barang, buat pilihan cepat di kolom "Nama Pengirim" — beda barang/pemasok biasanya beda orang yang antar.
const NAMA_PENGIRIM_UMUM = [KOPERASI_INFO.penandaTangan, 'Farhan', 'Pak Margi'];

const CATATAN_PENERIMAAN_STANDAR = 'Mohon lakukan pemeriksaan jumlah dan kondisi barang saat penerimaan. Barang yang sudah ditandatangani dianggap telah diterima dalam keadaan baik dan lengkap.';

/** Buka/tutup form kecil "Nama Pengirim" sebelum benar-benar cetak — satu nota bisa dikirim orang berbeda-beda tergantung asal barangnya. */
function toggleSuratJalanForm(notaId) {
  suratJalanExpandId = suratJalanExpandId === notaId ? null : notaId;
  renderDistribusiSppg();
}

function suratJalanFormHtml(nota) {
  const groups = kelompokkanPerPengirim(nota);
  const groupsHtml = groups.map((g, idx) => `
    <div class="surat-jalan-group">
      <div class="po-invoice-fields">
        <label style="flex:1;min-width:240px;">
          Pengirim
          <select id="suratJalanPengirim-${nota.id}-${idx}">
            ${NAMA_PENGIRIM_UMUM.map(nama => `<option value="${escapeHtml(nama)}"${nama === g.pengirim ? ' selected' : ''}>${escapeHtml(nama)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="surat-jalan-item-checklist">
        ${g.items.map((it, itemIdx) => `
          <label class="surat-jalan-item-check">
            <input type="checkbox" checked data-suratjalan-item="${nota.id}-${idx}-${itemIdx}">
            <span>${escapeHtml(it.namaBarang)} — ${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
  const label = groups.length > 1 ? `Cetak ${groups.length} Surat Jalan` : 'Cetak Surat Jalan';
  return `
    <div class="po-inline-form" data-suratjalan-form="${nota.id}">
      <h4>Centang barang yang mau dimasukkan ke Surat Jalan${groups.length > 1 ? `, dipecah otomatis jadi ${groups.length} kelompok pengirim` : ''}:</h4>
      ${groupsHtml}
      <div class="po-inline-form-actions">
        <button type="button" class="btn-ghost" data-suratjalan-cancel="${nota.id}">Batal</button>
        <button type="button" class="btn" data-suratjalan-submit="${nota.id}">${nota.suratJalanNomor ? `Cetak Ulang${groups.length > 1 ? ` (${groups.length})` : ''}` : label}</button>
      </div>
    </div>`;
}

/**
 * Nomor surat jalan sekali dibuat lalu dipatri ke notanya (mirip pola nomor invoice di PO SPPG) — cetak
 * ulang memakai nomor yang sama, bukan bikin baru. Kalau barangnya kepecah ke beberapa pengirim, nomornya
 * tetap satu (satu nota = satu nomor) tapi dicetak jadi beberapa halaman, satu halaman per pengirim.
 */
async function submitSuratJalan(notaId) {
  const nota = state.lastDistribusiSppgItems.find(n => n.id === notaId);
  if (!nota) return;
  const groups = kelompokkanPerPengirim(nota).map((g, idx) => {
    const input = document.getElementById(`suratJalanPengirim-${notaId}-${idx}`);
    const pengirim = (input ? input.value.trim() : '') || g.pengirim;
    const items = g.items.filter((it, itemIdx) => {
      const cb = document.querySelector(`[data-suratjalan-item="${notaId}-${idx}-${itemIdx}"]`);
      return cb ? cb.checked : true;
    });
    return { pengirim, items };
  }).filter(g => g.items.length > 0);

  if (groups.length === 0) {
    alert('Pilih minimal satu barang untuk dicetak.');
    return;
  }

  const tanggalSurat = nota.suratJalanTanggal || nota.tanggalKirim || todayIso();
  const nomor = nota.suratJalanNomor || nextSuratJalanNomor(tanggalSurat.slice(0, 4));
  const pengirimGabungan = groups.map(g => g.pengirim).join(', ');

  try {
    await updateDoc(doc(state.db, 'distribusiSppg', notaId), {
      suratJalanNomor: nomor, suratJalanTanggal: tanggalSurat, suratJalanPengirim: pengirimGabungan,
      updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    if (!nota.suratJalanNomor) {
      logActivity({ action: 'ubah', modul: 'Koperasi - Distribusi SPPG', ringkasan: `Cetak Surat Jalan ${nomor} untuk ${nota.tujuanSppg} (pengirim: ${pengirimGabungan})` });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan surat jalan. Cetak dibatalkan.');
    return;
  }

  suratJalanExpandId = null;
  printSuratJalanBody({ ...nota, suratJalanNomor: nomor, suratJalanTanggal: tanggalSurat }, groups);
}

function suratJalanPageHtml(nota, pengirim, items, needsPageBreak) {
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(it.namaBarang)}</td>
      <td style="text-align:right">${it.jumlah ?? '-'}</td>
      <td>${escapeHtml(it.satuan || '')}</td>
    </tr>
  `).join('');

  const ttdPengirim = TTD_PENGIRIM[pengirim.trim().toLowerCase()];

  return `
    <div class="doc-accent-blue${needsPageBreak ? ' print-page-break' : ''}">
      <div class="invoice-head">
        ${suratJalanHeadCompanyHtml()}
        <div class="invoice-title">SURAT JALAN</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">Kepada: <b>${escapeHtml(nota.tujuanSppg)}</b></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Nomor:</span> ${escapeHtml(nota.suratJalanNomor)}</div>
          <div class="row"><span class="lbl">Tanggal:</span> ${formatDate(nota.tanggalKirim)}${nota.jamKirim ? ', ' + escapeHtml(nota.jamKirim) : ''}</div>
        </div>
      </div>
      <table class="invoice-table">
        <thead><tr><th>No</th><th>Nama Barang</th><th>Jumlah</th><th>Satuan</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${nota.catatan ? `<div style="margin-top:12px;font-size:11.5px;"><b>Catatan:</b> ${escapeHtml(nota.catatan)}</div>` : ''}
      <div style="margin-top:6px;font-size:10.5px;color:#555;">${escapeHtml(CATATAN_PENERIMAAN_STANDAR)}</div>
      <div class="invoice-signature-3col">
        <div>Pengirim,</div>
        <div>Penerima,</div>
        <div>Sopir / Pembawa,</div>
        ${ttdPengirim ? `
        <div class="sig-visual">
          ${ttdPengirim.stempel ? `<img class="sig-stempel" src="${ttdPengirim.stempel}" alt="">` : ''}
          <img class="sig-ttd${ttdPengirim.stempel ? '' : ' sig-ttd-solo'}" src="${ttdPengirim.ttd}" alt="">
        </div>` : `<div class="sig-space"></div>`}
        <div class="sig-space"></div>
        <div class="sig-space"></div>
        <div class="sig-name">${escapeHtml(pengirim)}</div>
        <div class="sig-name">&nbsp;</div>
        <div class="sig-name">&nbsp;</div>
        <div>${escapeHtml(KOPERASI_INFO.nama)}</div>
        <div>${escapeHtml(nota.tujuanSppg)}</div>
        <div>&nbsp;</div>
      </div>
    </div>
  `;
}

/** Satu nota bisa dicetak jadi beberapa Surat Jalan (satu halaman per pengirim) dalam satu kali cetak. */
function printSuratJalanBody(nota, groups) {
  const body = groups.map((g, idx) => suratJalanPageHtml(nota, g.pengirim, g.items, idx > 0)).join('');
  printReport(body, `SuratJalan-${slugifyTujuan(nota.tujuanSppg)}-${fileDateTag(nota.tanggalKirim)}`);
}

export function renderDistribusiSppg() {
  const logEl = document.getElementById('sppgLog');
  const notaList = filteredNota();
  const items = flattenItems(notaList);

  let totalNilai = 0;
  items.forEach(it => { totalNilai += itemNilai(it) || 0; });
  const totalNilaiEl = document.getElementById('sppgTotalNilai');
  const totalItemEl = document.getElementById('sppgTotalItem');
  if (totalNilaiEl) totalNilaiEl.textContent = formatRupiah(totalNilai);
  if (totalItemEl) totalItemEl.textContent = String(items.length);

  if (notaList.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada nota distribusi ke SPPG untuk rentang tanggal ini.</div>`;
    return;
  }

  logEl.innerHTML = notaList.map(nota => {
    const jumlahBarang = (nota.items || []).length;
    const nilai = notaTotalNilai(nota);
    return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(nota.tujuanSppg)}</b>
        <div class="meta">Kirim: ${formatDate(nota.tanggalKirim)}${nota.jamKirim ? ', ' + escapeHtml(nota.jamKirim) : ''}</div>
        <div class="meta">${jumlahBarang} jenis barang${nota.catatan ? ' · ' + escapeHtml(nota.catatan) : ''}</div>
        <div class="meta">Dicatat ${formatTimestamp(nota.createdAt)}${nota.createdBy ? ' · oleh ' + escapeHtml(nota.createdBy) : ''}</div>
        ${nota.suratJalanNomor ? `<div class="meta">Surat Jalan ${escapeHtml(nota.suratJalanNomor)}</div>` : ''}
      </div>
      <div class="right">
        ${nilai > 0 ? `<div class="dist-item-total">${formatRupiah(nilai)}</div>` : ''}
        <div class="dist-item-actions">
          <button type="button" class="btn-ghost nota-toggle-btn" data-notaid="${nota.id}">Lihat Detail</button>
          <button type="button" class="btn-ghost nota-suratjalan-btn" data-notaid="${nota.id}">${nota.suratJalanNomor ? 'Cetak Ulang Surat Jalan' : 'Cetak Surat Jalan'}</button>
          <button class="edit-btn" data-editid="${nota.id}" title="Edit nota ini">✏️</button>
          <button class="del-btn" data-delid="${nota.id}" title="Hapus nota ini">🗑</button>
        </div>
      </div>
    </div>
    <div class="nota-detail hidden" id="notaDetail-${nota.id}">
      ${(nota.items || []).map(it => {
        const nilai = itemNilai(it);
        const title = typeof it.hargaJual === 'number' ? `@ ${formatRupiah(it.hargaJual)} / ${escapeHtml(it.satuan || 'satuan')}` : '';
        return `
        <div class="nota-detail-row">
          <span class="nota-detail-nama">${escapeHtml(it.namaBarang)}</span>
          <span class="nota-detail-qty">${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
          <span class="nota-detail-harga" title="${title}">${nilai !== null ? formatRupiah(nilai) : '-'}</span>
        </div>
      `;
      }).join('')}
    </div>
    ${suratJalanExpandId === nota.id ? suratJalanFormHtml(nota) : ''}`;
  }).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteDistribusiSppg(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.nota-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const detail = document.getElementById('notaDetail-' + btn.dataset.notaid);
      const nowHidden = detail.classList.toggle('hidden');
      btn.textContent = nowHidden ? 'Lihat Detail' : 'Sembunyikan Detail';
    });
  });
  logEl.querySelectorAll('button.nota-suratjalan-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleSuratJalanForm(btn.dataset.notaid));
  });
  logEl.querySelectorAll('[data-suratjalan-cancel]').forEach(btn => {
    btn.addEventListener('click', () => toggleSuratJalanForm(btn.dataset.suratjalanCancel));
  });
  logEl.querySelectorAll('[data-suratjalan-submit]').forEach(btn => {
    btn.addEventListener('click', () => submitSuratJalan(btn.dataset.suratjalanSubmit));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nota = state.lastDistribusiSppgItems.find(it => it.id === btn.dataset.editid);
      if (nota) startEditSppg(nota);
    });
  });
}

function startEditSppg(nota) {
  editingId = nota.id;
  document.getElementById('sppgTanggalKirim').value = nota.tanggalKirim || '';
  document.getElementById('sppgJamKirim').value = nota.jamKirim || '';
  document.getElementById('sppgTujuan').value = nota.tujuanSppg || '';
  document.getElementById('sppgCatatan').value = nota.catatan || '';

  document.getElementById('sppgItemRows').innerHTML = '';
  rowCounter = 0;
  const items = nota.items || [];
  if (items.length === 0) {
    addItemRow();
  } else {
    items.forEach(item => addItemRow(item));
  }

  document.getElementById('btnSaveSppg').textContent = 'Update Nota Pengiriman';
  document.getElementById('btnCancelEditSppg').classList.remove('hidden');
  document.getElementById('sppgTujuan').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditSppg() {
  editingId = null;
  linkedPoId = null;
  document.getElementById('sppgTujuan').value = '';
  document.getElementById('sppgCatatan').value = '';
  resetItemRows();
  document.getElementById('btnSaveSppg').textContent = 'Simpan Nota Pengiriman';
  document.getElementById('btnCancelEditSppg').classList.add('hidden');
}

/** Dipanggil dari ui-po-sppg.js ("Buat Nota Pengiriman →") — isi form dari PO yang sudah disetujui SPPG. */
export function prefillFromPo(po) {
  editingId = null;
  linkedPoId = po.id;
  document.getElementById('sppgTanggalKirim').value = todayIso();
  document.getElementById('sppgJamKirim').value = '';
  document.getElementById('sppgTujuan').value = po.tujuanSppg || '';
  document.getElementById('sppgCatatan').value = `Dari PO ${formatDate(po.tanggalPo)}${po.catatan ? ' — ' + po.catatan : ''}`;

  document.getElementById('sppgItemRows').innerHTML = '';
  rowCounter = 0;
  const items = po.items || [];
  if (items.length === 0) {
    addItemRow();
  } else {
    items.forEach(item => addItemRow({
      namaBarang: item.namaBarang, jumlah: item.jumlah, satuan: item.satuan,
      hargaJual: typeof item.hargaFinal === 'number' ? item.hargaFinal : item.hargaRencana,
    }));
  }

  document.getElementById('btnSaveSppg').textContent = `Simpan Nota Pengiriman (dari PO ${po.tujuanSppg})`;
  document.getElementById('btnCancelEditSppg').classList.remove('hidden');
  document.getElementById('sppgTujuan').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteDistribusiSppg(id) {
  if (!id) return;
  if (!confirm('Hapus nota distribusi ini beserta seluruh barang di dalamnya? Tindakan ini tidak bisa dibatalkan.')) return;
  const nota = state.lastDistribusiSppgItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'distribusiSppg', id));
    if (nota) {
      logActivity({
        action: 'hapus',
        modul: 'Koperasi - Distribusi SPPG',
        ringkasan: `Hapus nota distribusi ke ${nota.tujuanSppg} (${(nota.items || []).length} jenis barang)`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveDistribusiSppg() {
  const tanggalKirim = document.getElementById('sppgTanggalKirim').value;
  const jamKirim = document.getElementById('sppgJamKirim').value;
  const tujuanSppg = document.getElementById('sppgTujuan').value.trim();
  const catatan = document.getElementById('sppgCatatan').value.trim();
  const items = readItemRows();

  if (!tanggalKirim || !tujuanSppg) {
    alert('Mohon isi tanggal kirim dan tujuan/nama SPPG.');
    return;
  }
  if (items.length === 0 || items.some(it => !it.namaBarang || !it.jumlah || !it.satuan)) {
    alert('Mohon isi nama barang, jumlah, dan satuan untuk setiap baris barang dalam nota ini.');
    return;
  }

  const entry = { tanggalKirim, jamKirim, tujuanSppg, catatan, items };
  const isEdit = !!editingId;
  if (isEdit) {
    entry.updatedAt = serverTimestamp();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.createdAt = serverTimestamp();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSaveSppg');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'distribusiSppg', editingId), entry);
      logActivity({
        action: 'ubah',
        modul: 'Koperasi - Distribusi SPPG',
        ringkasan: `Update nota distribusi ke ${tujuanSppg} (${items.length} jenis barang)`,
      });
      cancelEditSppg();
    } else {
      if (linkedPoId) entry.poId = linkedPoId;
      const ref = await addDoc(collection(state.db, 'distribusiSppg'), entry);
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Distribusi SPPG',
        ringkasan: `Nota distribusi ke ${tujuanSppg} (${items.length} jenis barang)`,
      });
      if (linkedPoId) {
        await markPoTerkirim(linkedPoId, ref.id);
        linkedPoId = null;
      }
      document.getElementById('sppgTujuan').value = '';
      document.getElementById('sppgCatatan').value = '';
      resetItemRows();
      document.getElementById('btnSaveSppg').textContent = 'Simpan Nota Pengiriman';
      document.getElementById('btnCancelEditSppg').classList.add('hidden');
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan nota distribusi. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Nota Pengiriman' : 'Simpan Nota Pengiriman';
  }
}

export function downloadLaporanDistribusiSppg() {
  const dari = document.getElementById('sppgFilterDari').value;
  const sampai = document.getElementById('sppgFilterSampai').value;
  const notaList = filteredNota();

  if (notaList.length === 0) {
    alert('Tidak ada data distribusi ke SPPG untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal Kirim', 'Jam Kirim', 'Tujuan SPPG', 'Catatan Nota', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga Satuan Jual (Rp)', 'Subtotal (Rp)', 'Diinput Oleh', 'Dicatat Pada'];
  const rows = [];
  notaList.forEach(nota => {
    (nota.items || []).forEach(item => {
      rows.push([
        formatDate(nota.tanggalKirim), nota.jamKirim || '', nota.tujuanSppg, nota.catatan || '',
        item.namaBarang, item.jumlah ?? '', item.satuan || '', item.hargaJual ?? '', itemNilai(item) ?? '',
        nota.createdBy || '', formatTimestamp(nota.createdAt),
      ]);
    });
  });

  const totalNilai = flattenItems(notaList).reduce((s, it) => s + (itemNilai(it) || 0), 0);
  rows.push([]);
  rows.push(['TOTAL NILAI DISTRIBUSI', '', '', '', '', '', '', '', totalNilai]);

  downloadCsv(`Laporan-Distribusi-SPPG-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initDistribusiSppgEvents() {
  document.getElementById('btnSaveSppg').addEventListener('click', saveDistribusiSppg);
  document.getElementById('btnTambahBarangSppg').addEventListener('click', addItemRow);
  const { dari, sampai } = monthRange();
  document.getElementById('sppgFilterDari').value = dari;
  document.getElementById('sppgFilterSampai').value = sampai;
  document.getElementById('sppgFilterDari').addEventListener('change', renderDistribusiSppg);
  document.getElementById('sppgFilterSampai').addEventListener('change', renderDistribusiSppg);
  document.getElementById('btnSppgFilterReset').addEventListener('click', () => {
    document.getElementById('sppgFilterDari').value = '';
    document.getElementById('sppgFilterSampai').value = '';
    renderDistribusiSppg();
  });
  document.getElementById('btnDownloadSppg').addEventListener('click', downloadLaporanDistribusiSppg);
  document.getElementById('btnCancelEditSppg').addEventListener('click', cancelEditSppg);
  resetItemRows();
}
