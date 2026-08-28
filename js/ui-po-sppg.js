// ---------- Koperasi Bahan Makanan — PO dari SPPG: alur pesanan sampai invoice ----------
// Satu PO = satu dokumen di collection "poSppg", berisi array `items` (mirip
// Distribusi SPPG). Status PO berjalan bertahap:
//   menunggu_pembelian -> menunggu_persetujuan -> disetujui/ditolak -> terkirim
// Saat "disetujui", PO bisa dijadikan Nota Pengiriman (lewat state.poPrefill,
// dibaca oleh ui-distribusi-sppg.js). Saat "terkirim", PO bisa dicetak jadi
// Invoice/Berita Acara (nomor invoice otomatis, format INV/{tahun}/{urut}).
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { KOPERASI_INFO } from './data.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, escapeHtml, todayIso } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';
import { printReport } from './print-report.js';
import { navigateTo } from './router.js';
import { PO_LAMA_BATCH, PO_LAMA_DATA } from './po-lama-data.js';

const LOGO_URL = 'assets/invoice/logo-koperasi.png';
const STEMPEL_URL = 'assets/invoice/stempel-koperasi.png';
const TTD_URL = 'assets/invoice/ttd-koperasi.jpg';

/** "Dapur SPPG Sudimara Jaya" -> "Dapur_SPPG_Sudimara_Jaya" — dipakai untuk nama file unduhan. */
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

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Kunci stabil untuk satu baris barang PO — dipakai Pembelian untuk menaut ke barang PO tertentu.
 * PO lama (sebelum fitur ini ada) belum punya `itemId` tersimpan, jadi jatuh ke index sebagai fallback. */
export function poItemKey(item, index) {
  return item.itemId || ('idx' + index);
}

function invoiceHeadCompanyHtml() {
  return `
    <div class="invoice-head-company">
      <img class="invoice-logo" src="${LOGO_URL}" alt="Logo ${escapeHtml(KOPERASI_INFO.namaSingkat)}">
      <div>
        <b>${escapeHtml(KOPERASI_INFO.nama.toUpperCase())}</b>
        ${KOPERASI_INFO.alamatBaris.map(line => `<div class="addr">${escapeHtml(line)}</div>`).join('')}
      </div>
    </div>`;
}

const STATUS_LABEL = {
  menunggu_pembelian: 'Menunggu Pembelian',
  menunggu_persetujuan: 'Menunggu Persetujuan SPPG',
  disetujui: 'Disetujui — Siap Kirim',
  ditolak: 'Ditolak',
  terkirim: 'Terkirim',
};

let rowCounter = 0;
let editingId = null;
let confirmExpandId = null; // PO yang sedang dibuka form "Konfirmasi Harga"-nya
let invoiceExpandId = null; // PO yang sedang dibuka form Potongan/PPN sebelum cetak invoice

function itemRowHtml(rowId) {
  return `
    <div class="nota-item-row" data-rowid="${rowId}">
      <input class="nir-nama" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga satuan rencana (opsional)">
        <button type="button" class="nir-remove" data-rowid="${rowId}" title="Hapus baris ini">✕</button>
      </div>
    </div>`;
}

function addItemRow(prefill) {
  rowCounter += 1;
  const wrap = document.getElementById('poItemRows');
  wrap.insertAdjacentHTML('beforeend', itemRowHtml(rowCounter));
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowCounter}"]`);
  row.querySelector('.nir-remove').addEventListener('click', () => removeItemRow(rowCounter));
  if (prefill) {
    row.querySelector('.nir-nama').value = prefill.namaBarang || '';
    row.querySelector('.nir-jumlah').value = prefill.jumlah ?? '';
    row.querySelector('.nir-satuan').value = prefill.satuan || '';
    row.querySelector('.nir-harga').value = prefill.hargaRencana ?? '';
    if (prefill.itemId) row.dataset.itemid = prefill.itemId;
  }
}

function removeItemRow(rowId) {
  const wrap = document.getElementById('poItemRows');
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowId}"]`);
  if (row) row.remove();
  if (wrap.children.length === 0) addItemRow();
}

function resetItemRows() {
  document.getElementById('poItemRows').innerHTML = '';
  rowCounter = 0;
  addItemRow();
}

function readItemRows() {
  const rows = document.querySelectorAll('#poItemRows .nota-item-row');
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
      hargaRencana: harga === '' ? null : Number(harga),
      hargaFinal: null,
      itemId: row.dataset.itemid || genId(),
    });
  });
  return items;
}

export function watchPoSppg(onChange) {
  const logEl = document.getElementById('poSppgLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data PO...</div>`;
  const q = query(collection(state.db, 'poSppg'), orderBy('createdAt', 'desc'), limit(300));
  if (state.poSppgUnsub) state.poSppgUnsub();
  state.poSppgUnsub = onSnapshot(q, (qs) => {
    state.lastPoSppgItems = [];
    qs.forEach(d => state.lastPoSppgItems.push({ id: d.id, ...d.data() }));
    renderPoSppg();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data PO dari SPPG.</div>`;
  });
}

function filteredPo() {
  const dari = document.getElementById('poFilterDari').value;
  const sampai = document.getElementById('poFilterSampai').value;
  const status = document.getElementById('poFilterStatus').value;
  return state.lastPoSppgItems.filter(po => {
    if (status !== 'all' && po.status !== status) return false;
    if ((dari || sampai) && !isDateStrInRange(po.tanggalPo, dari, sampai)) return false;
    return true;
  });
}

/** Total nilai PO (harga satuan x jumlah per barang) — pakai harga final kalau sudah dikonfirmasi, kalau belum pakai harga rencana. */
function poTotal(po) {
  const items = po.items || [];
  const hasFinal = items.some(it => typeof it.hargaFinal === 'number');
  return items.reduce((sum, it) => {
    const h = hasFinal ? it.hargaFinal : it.hargaRencana;
    const jumlah = typeof it.jumlah === 'number' ? it.jumlah : 0;
    return sum + (typeof h === 'number' ? h * jumlah : 0);
  }, 0);
}

function itemSubtotal(it, useFinal) {
  const h = useFinal ? it.hargaFinal : it.hargaRencana;
  const jumlah = typeof it.jumlah === 'number' ? it.jumlah : 0;
  return typeof h === 'number' ? h * jumlah : null;
}

export function renderPoSppg() {
  const logEl = document.getElementById('poSppgLog');
  const list = filteredPo();

  const menungguTindakan = state.lastPoSppgItems.filter(po =>
    po.status === 'menunggu_pembelian' || po.status === 'menunggu_persetujuan' || po.status === 'disetujui'
  ).length;
  const aktif = state.lastPoSppgItems.filter(po => po.status !== 'terkirim' && po.status !== 'ditolak').length;
  const menungguEl = document.getElementById('poMenungguTindakan');
  const aktifEl = document.getElementById('poAktifCount');
  if (menungguEl) menungguEl.textContent = String(menungguTindakan);
  if (aktifEl) aktifEl.textContent = String(aktif);

  const importBar = document.getElementById('poImportBar');
  if (importBar) importBar.classList.toggle('hidden', isArsipImported());

  if (list.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada PO dari SPPG untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = list.map(po => renderCard(po)).join('');
  wireCardActions(logEl);
}

function isArsipImported() {
  return state.lastPoSppgItems.some(po => po.importBatch === PO_LAMA_BATCH);
}

async function importArsipLama() {
  if (!confirm(`Import ${PO_LAMA_DATA.length} arsip PO lama (Maret–Agustus 2026) ke sistem? Data masuk berstatus "Terkirim" sebagai riwayat, tidak memicu invoice.`)) return;
  const existingKeys = new Set(
    state.lastPoSppgItems.filter(po => po.importBatch === PO_LAMA_BATCH).map(po => `${po.tanggalPo}|${po.tujuanSppg}`)
  );
  const btn = document.getElementById('btnImportArsipPo');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengimpor...'; }
  let count = 0;
  for (const rec of PO_LAMA_DATA) {
    const key = `${rec.tanggalPo}|${rec.tujuanSppg}`;
    if (existingKeys.has(key)) continue;
    try {
      await addDoc(collection(state.db, 'poSppg'), {
        tanggalPo: rec.tanggalPo,
        tujuanSppg: rec.tujuanSppg,
        items: rec.items,
        catatan: 'Arsip data lama (diimpor dari file PO Excel koperasi)',
        status: 'terkirim',
        distribusiId: null,
        invoiceNomor: null,
        importBatch: PO_LAMA_BATCH,
        createdAt: serverTimestamp(),
        createdBy: state.currentUserEmail,
      });
      existingKeys.add(key);
      count += 1;
    } catch (e) {
      console.error('Gagal impor PO arsip', rec.tanggalPo, rec.tujuanSppg, e);
    }
  }
  if (count > 0) {
    logActivity({ action: 'tambah', modul: 'Koperasi - PO SPPG', ringkasan: `Import arsip ${count} PO lama (Maret–Agustus 2026)` });
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Import Arsip Sekarang'; }
  alert(`Selesai. ${count} PO dari arsip berhasil diimpor.`);
}

/** Semua catatan Pembelian yang ditautkan ke barang PO tertentu (poId + itemId). */
function pembelianUntukPoItem(poId, itemId) {
  return (state.lastPembelianItems || []).filter(p => p.poId === poId && p.poItemId === itemId);
}

/** Realisasi pembelian (Rp total & qty) untuk satu barang PO — `harga` di Pembelian sudah berupa total per baris, bukan per satuan. */
function itemRealisasi(poId, itemId) {
  const purchases = pembelianUntukPoItem(poId, itemId);
  const totalRp = purchases.reduce((sum, p) => sum + (typeof p.harga === 'number' ? p.harga : 0), 0);
  const totalQty = purchases.reduce((sum, p) => sum + (typeof p.jumlah === 'number' ? p.jumlah : 0), 0);
  return { purchases, totalRp, totalQty };
}

/**
 * Total margin kotor (Harga Jual − Realisasi Beli) dari semua PO yang tanggalPo-nya
 * masuk rentang dari/sampai. Diekspor untuk dipakai Laporan Keuangan Koperasi
 * ("Total Profit Real" = margin kotor ini dikurangi Biaya Operasional).
 */
export function computeMarginKotor(dari, sampai) {
  const list = state.lastPoSppgItems.filter(po => isDateStrInRange(po.tanggalPo, dari, sampai));
  let total = 0;
  list.forEach(po => {
    const showFinal = po.status !== 'menunggu_pembelian';
    (po.items || []).forEach((it, idx) => {
      const hargaSatuan = showFinal ? it.hargaFinal : it.hargaRencana;
      if (typeof hargaSatuan !== 'number') return;
      const key = poItemKey(it, idx);
      const { totalRp: realisasi, totalQty: dibeli } = itemRealisasi(po.id, key);
      if (dibeli <= 0) return;
      total += (hargaSatuan * dibeli) - realisasi;
    });
  });
  return total;
}

function renderCard(po) {
  const items = po.items || [];
  const showFinal = po.status !== 'menunggu_pembelian';
  const total = poTotal(po);
  let marginPoTotal = null;

  const itemsHtml = items.map((it, idx) => {
    const hargaSatuan = showFinal ? it.hargaFinal : it.hargaRencana;
    const subtotal = itemSubtotal(it, showFinal);
    const label = typeof hargaSatuan === 'number'
      ? `${formatRupiah(subtotal)}${!showFinal ? ' (rencana)' : ''}`
      : '-';
    const title = typeof hargaSatuan === 'number' ? `@ ${formatRupiah(hargaSatuan)} / ${escapeHtml(it.satuan || 'satuan')}` : '';

    const key = poItemKey(it, idx);
    const { purchases, totalRp: realisasi, totalQty: dibeli } = itemRealisasi(po.id, key);

    let progressHtml = '';
    if (purchases.length > 0) {
      const jumlahOrder = typeof it.jumlah === 'number' ? it.jumlah : 0;
      const sisa = jumlahOrder - dibeli;
      const perToko = purchases.map(p => `${escapeHtml(p.namaToko || '-')}: ${p.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}`).join(', ');
      const purchaseLine = po.status === 'menunggu_pembelian'
        ? `${sisa <= 0 ? '✓' : '↻'} ${dibeli} ${escapeHtml(it.satuan || '')} sudah dibeli (${perToko})${sisa > 0 ? ` · sisa ${sisa} ${escapeHtml(it.satuan || '')}` : ' · terpenuhi'}`
        : `Dibeli dari: ${perToko}`;

      let marginHtml = '';
      if (typeof hargaSatuan === 'number' && dibeli > 0) {
        const hargaBeliSatuan = Math.round(realisasi / dibeli);
        const revenueSoFar = hargaSatuan * dibeli;
        const marginPo = revenueSoFar - realisasi;
        const marginSatuan = hargaSatuan - hargaBeliSatuan;
        marginPoTotal = (marginPoTotal ?? 0) + marginPo;
        const cls = marginPo >= 0 ? 'po-margin-line--positive' : 'po-margin-line--negative';
        marginHtml = `<div class="po-margin-line ${cls}">💰 Margin: ${formatRupiah(marginPo)} (${formatRupiah(marginSatuan)}/${escapeHtml(it.satuan || 'satuan')})${sisa > 0 ? ' · sementara' : ''}</div>`;
      }

      progressHtml = `
          <div class="po-purchase-progress${sisa <= 0 && po.status === 'menunggu_pembelian' ? ' po-purchase-progress--done' : ''}">${purchaseLine} · Realisasi ${formatRupiah(realisasi)}</div>
          ${marginHtml}`;
    }

    return `
    <div class="nota-detail-row">
      <span class="nota-detail-nama">${escapeHtml(it.namaBarang)}</span>
      <span class="nota-detail-qty">${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
      <span class="nota-detail-harga" title="${title}">${label}</span>
    </div>
    ${progressHtml}
  `;
  }).join('');

  return `
    <div class="po-card" data-poid="${po.id}">
      <div class="po-card-head">
        <div>
          <b>${escapeHtml(po.tujuanSppg)}</b>
          <div class="meta">PO: ${formatDate(po.tanggalPo)} · ${items.length} jenis barang${po.catatan ? ' · ' + escapeHtml(po.catatan) : ''}</div>
          <div class="meta">Dicatat ${formatTimestamp(po.createdAt)}${po.createdBy ? ' · oleh ' + escapeHtml(po.createdBy) : ''}</div>
          ${po.status === 'terkirim' ? `<div class="meta">Nota pengiriman sudah dibuat${po.invoiceNomor ? ' · Invoice ' + escapeHtml(po.invoiceNomor) : ''}</div>` : ''}
        </div>
        <span class="po-status-badge po-status-badge--${po.status}">${STATUS_LABEL[po.status] || po.status}</span>
      </div>
      <div class="po-card-items">${itemsHtml}</div>
      ${total > 0 ? `<div class="po-card-total">Total: ${formatRupiah(total)}</div>` : ''}
      ${marginPoTotal !== null ? `<div class="po-card-total po-card-total--margin ${marginPoTotal >= 0 ? 'po-margin-line--positive' : 'po-margin-line--negative'}">💰 Margin PO: ${formatRupiah(marginPoTotal)}</div>` : ''}
      ${renderInlineForm(po)}
      <div class="po-card-actions">${renderActions(po)}</div>
    </div>
  `;
}

function renderInlineForm(po) {
  if (po.status === 'menunggu_pembelian' && confirmExpandId === po.id) {
    const rows = (po.items || []).map((it, idx) => `
      <div class="po-inline-row">
        <span>${escapeHtml(it.namaBarang)}</span>
        <span>${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
        <input type="number" class="po-confirm-harga" data-idx="${idx}" placeholder="Harga satuan final" value="${it.hargaRencana ?? ''}">
      </div>
    `).join('');
    return `
      <div class="po-inline-form" data-form="confirm">
        <h4>Isi harga satuan final per barang (hasil belanja), lalu kirim ke SPPG:</h4>
        ${rows}
        <div class="po-inline-form-actions">
          <button type="button" class="btn-ghost" data-po-cancel-confirm="${po.id}">Batal</button>
          <button type="button" class="btn" data-po-submit-confirm="${po.id}">Simpan &amp; Kirim ke SPPG</button>
        </div>
      </div>`;
  }
  if (po.status === 'terkirim' && invoiceExpandId === po.id) {
    return `
      <div class="po-inline-form" data-form="invoice">
        <h4>Detail sebelum cetak Invoice/Berita Acara:</h4>
        <div class="po-invoice-fields">
          <label>Potongan (%)<input type="number" step="0.1" id="poInvoicePotongan-${po.id}" value="${po.invoicePotongan ?? 0}"></label>
          <label>PPN (%)<input type="number" step="0.1" id="poInvoicePpn-${po.id}" value="${po.invoicePpn ?? 0}"></label>
        </div>
        <div class="po-inline-form-actions">
          <button type="button" class="btn-ghost" data-po-cancel-invoice="${po.id}">Batal</button>
          <button type="button" class="btn" data-po-submit-invoice="${po.id}">${po.invoiceNomor ? 'Cetak Ulang Invoice' : 'Cetak Invoice'}</button>
        </div>
      </div>`;
  }
  return '';
}

function renderActions(po) {
  const actions = [];
  if (po.status === 'menunggu_pembelian') {
    actions.push(`<button type="button" class="edit-btn" data-po-edit="${po.id}" title="Edit PO">✏️</button>`);
    if (confirmExpandId !== po.id) {
      actions.push(`<button type="button" class="btn" data-po-confirm="${po.id}">Konfirmasi Harga ke SPPG</button>`);
    }
  } else if (po.status === 'menunggu_persetujuan') {
    actions.push(`<button type="button" class="btn-ghost" data-po-print-konfirmasi="${po.id}">Cetak Konfirmasi Harga (PDF)</button>`);
    actions.push(`<button type="button" class="btn-ghost" data-po-reject="${po.id}">SPPG Menolak</button>`);
    actions.push(`<button type="button" class="btn" data-po-approve="${po.id}">SPPG Setuju</button>`);
  } else if (po.status === 'disetujui') {
    actions.push(`<button type="button" class="btn-ghost" data-po-print-persetujuan="${po.id}">Cetak Persetujuan Harga (PDF)</button>`);
    actions.push(`<button type="button" class="btn" data-po-buat-nota="${po.id}">Buat Nota Pengiriman →</button>`);
  } else if (po.status === 'terkirim') {
    if (invoiceExpandId !== po.id) {
      actions.push(`<button type="button" class="btn" data-po-invoice="${po.id}">${po.invoiceNomor ? 'Cetak Ulang Invoice' : 'Cetak Invoice / Berita Acara'}</button>`);
    }
  }
  actions.push(`<button type="button" class="btn-danger" data-po-delete="${po.id}" title="Hapus PO ini">🗑 Hapus</button>`);
  return actions.join('');
}

function wireCardActions(root) {
  root.querySelectorAll('[data-po-edit]').forEach(btn => btn.addEventListener('click', () => {
    const po = state.lastPoSppgItems.find(p => p.id === btn.dataset.poEdit);
    if (po) startEditPo(po);
  }));
  root.querySelectorAll('[data-po-confirm]').forEach(btn => btn.addEventListener('click', () => {
    confirmExpandId = btn.dataset.poConfirm;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-cancel-confirm]').forEach(btn => btn.addEventListener('click', () => {
    confirmExpandId = null;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-submit-confirm]').forEach(btn => btn.addEventListener('click', () => submitConfirmHarga(btn.dataset.poSubmitConfirm)));
  root.querySelectorAll('[data-po-approve]').forEach(btn => btn.addEventListener('click', () => setStatus(btn.dataset.poApprove, 'disetujui')));
  root.querySelectorAll('[data-po-reject]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('Tandai PO ini ditolak oleh SPPG?')) return;
    setStatus(btn.dataset.poReject, 'ditolak');
  }));
  root.querySelectorAll('[data-po-buat-nota]').forEach(btn => btn.addEventListener('click', () => buatNotaDariPo(btn.dataset.poBuatNota)));
  root.querySelectorAll('[data-po-invoice]').forEach(btn => btn.addEventListener('click', () => {
    invoiceExpandId = btn.dataset.poInvoice;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-cancel-invoice]').forEach(btn => btn.addEventListener('click', () => {
    invoiceExpandId = null;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-submit-invoice]').forEach(btn => btn.addEventListener('click', () => cetakInvoice(btn.dataset.poSubmitInvoice)));
  root.querySelectorAll('[data-po-print-konfirmasi]').forEach(btn => btn.addEventListener('click', () => cetakKonfirmasiHarga(btn.dataset.poPrintKonfirmasi)));
  root.querySelectorAll('[data-po-print-persetujuan]').forEach(btn => btn.addEventListener('click', () => cetakPersetujuanHarga(btn.dataset.poPrintPersetujuan)));
  root.querySelectorAll('[data-po-delete]').forEach(btn => btn.addEventListener('click', () => deletePo(btn.dataset.poDelete)));
}

async function submitConfirmHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = (po.items || []).map((it, idx) => {
    const input = document.querySelector(`.po-confirm-harga[data-idx="${idx}"]`);
    const val = input ? input.value : '';
    return { ...it, hargaFinal: val === '' ? null : Number(val) };
  });
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      items, status: 'menunggu_persetujuan', updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Konfirmasi harga PO ${po.tujuanSppg}, dikirim untuk persetujuan SPPG` });
    confirmExpandId = null;
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan konfirmasi harga. Pastikan Anda sudah login.');
  }
}

async function setStatus(poId, status) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), { status, updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail });
    logActivity({
      action: 'ubah', modul: 'Koperasi - PO SPPG',
      ringkasan: `PO ${po.tujuanSppg} ${status === 'disetujui' ? 'disetujui SPPG' : 'ditolak SPPG'}`,
    });
  } catch (e) {
    console.error(e);
    alert('Gagal mengubah status PO. Pastikan Anda sudah login.');
  }
}

function buatNotaDariPo(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  state.poPrefill = po;
  navigateTo('koperasi', 'distribusisppg');
}

/** Dipanggil dari ui-distribusi-sppg.js setelah nota pengiriman yang ditautkan ke PO ini berhasil disimpan. */
export async function markPoTerkirim(poId, distribusiId) {
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      status: 'terkirim', distribusiId, updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
  } catch (e) {
    console.error('Gagal menandai PO sebagai terkirim', e);
  }
}

function nextInvoiceNomor(year) {
  const prefix = `INV/${year}/`;
  let max = 0;
  state.lastPoSppgItems.forEach(po => {
    if (po.invoiceNomor && po.invoiceNomor.startsWith(prefix)) {
      const n = parseInt(po.invoiceNomor.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

async function cetakInvoice(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const potonganInput = document.getElementById(`poInvoicePotongan-${poId}`);
  const ppnInput = document.getElementById(`poInvoicePpn-${poId}`);
  const potongan = potonganInput ? Number(potonganInput.value || 0) : (po.invoicePotongan || 0);
  const ppn = ppnInput ? Number(ppnInput.value || 0) : (po.invoicePpn || 0);
  const tanggalInvoice = po.invoiceTanggal || todayIso();
  const nomor = po.invoiceNomor || nextInvoiceNomor(tanggalInvoice.slice(0, 4));

  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      invoiceNomor: nomor, invoiceTanggal: tanggalInvoice, invoicePotongan: potongan, invoicePpn: ppn,
      updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    if (!po.invoiceNomor) {
      logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Cetak Invoice ${nomor} untuk PO ${po.tujuanSppg}` });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan nomor invoice. Cetak dibatalkan.');
    return;
  }

  printInvoiceBody({ ...po, invoiceNomor: nomor, invoiceTanggal: tanggalInvoice, invoicePotongan: potongan, invoicePpn: ppn });
  invoiceExpandId = null;
}

function cetakKonfirmasiHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = po.items || [];
  let totalRencana = 0, totalFinal = 0;
  const rows = items.map((it, i) => {
    const subRencana = itemSubtotal(it, false);
    const subFinal = itemSubtotal(it, true);
    if (typeof subRencana === 'number') totalRencana += subRencana;
    if (typeof subFinal === 'number') totalFinal += subFinal;
    const selisih = (typeof subFinal === 'number' && typeof subRencana === 'number') ? subFinal - subRencana : null;
    const selisihLabel = typeof selisih === 'number' ? (selisih === 0 ? 'Sama' : (selisih > 0 ? '+' : '−') + formatRupiah(Math.abs(selisih)).replace('Rp ', '')) : '-';
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(it.namaBarang)}</td>
        <td>${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</td>
        <td style="text-align:right">${typeof subRencana === 'number' ? formatRupiah(subRencana).replace('Rp ', '') : '-'}</td>
        <td style="text-align:right">${typeof subFinal === 'number' ? formatRupiah(subFinal).replace('Rp ', '') : '-'}</td>
        <td style="text-align:right">${selisihLabel}</td>
      </tr>`;
  }).join('');
  const selisihTotal = totalFinal - totalRencana;

  const body = `
    <div class="doc-accent-blue">
      <div class="invoice-head">
        ${invoiceHeadCompanyHtml()}
        <div class="invoice-title">KONFIRMASI HARGA</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">Untuk: <b>${escapeHtml(po.tujuanSppg)}</b><div style="font-size:10.5px;color:#555;margin-top:3px;">Mohon ditinjau &amp; disetujui sebelum barang dikirim.</div></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Tanggal PO:</span> ${formatDate(po.tanggalPo)}</div>
          <div class="row"><span class="lbl">Dicetak:</span> ${formatDate(todayIso())}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>No</th><th>Nama Barang</th><th>Qty</th><th>Subtotal Rencana</th><th>Subtotal Final</th><th>Selisih</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="invoice-bottom-row">
        <div class="invoice-pay-box">
          <div class="title">Catatan</div>
          <div>Harga final adalah hasil belanja aktual ke supplier, sehingga bisa berbeda dari harga rencana di awal PO.</div>
        </div>
        <div class="invoice-total-box">
          <div class="row"><span>Total Rencana</span><span>${formatRupiah(totalRencana)}</span></div>
          <div class="row"><span>Total Final</span><span>${formatRupiah(totalFinal)}</span></div>
          <div class="row total"><span>Selisih</span><span>${selisihTotal >= 0 ? '+' : '−'}${formatRupiah(Math.abs(selisihTotal))}</span></div>
        </div>
      </div>
      <div class="invoice-signature-2col">
        <div>
          <div>Disiapkan oleh,</div>
          <div class="sig-space"></div>
          <div class="sig-name">${escapeHtml(KOPERASI_INFO.penandaTangan)}</div>
          <div>${escapeHtml(KOPERASI_INFO.nama)}</div>
        </div>
        <div class="right">
          <div>Diperiksa &amp; disetujui oleh,</div>
          <div class="sig-space"></div>
          <div class="sig-name">&nbsp;</div>
          <div>${escapeHtml(po.tujuanSppg)}</div>
        </div>
      </div>
    </div>
  `;
  printReport(body, `Konfirmasi-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.tanggalPo)}`);
}

function cetakPersetujuanHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = po.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(it.namaBarang)}</td>
      <td>${it.jumlah ?? '-'}</td>
      <td>${escapeHtml(it.satuan || '')}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' ? formatRupiah(it.hargaFinal).replace('Rp ', '') : '-'}</td>
      <td style="text-align:right">${typeof itemSubtotal(it, true) === 'number' ? formatRupiah(itemSubtotal(it, true)).replace('Rp ', '') : '-'}</td>
    </tr>`).join('');
  const total = poTotal(po);

  const body = `
    <div class="doc-accent-blue">
      <div class="invoice-head">
        ${invoiceHeadCompanyHtml()}
        <div class="invoice-title">PERSETUJUAN HARGA</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">Untuk: <b>${escapeHtml(po.tujuanSppg)}</b><div style="font-size:10.5px;color:#2F8F4E;font-weight:700;margin-top:3px;">✓ Harga sudah disetujui SPPG — siap dikirim.</div></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Tanggal PO:</span> ${formatDate(po.tanggalPo)}</div>
          <div class="row"><span class="lbl">Dicetak:</span> ${formatDate(todayIso())}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>No</th><th>Nama Barang</th><th>Qty</th><th>Satuan</th><th>Harga Satuan</th><th>Nominal</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="invoice-bottom-row">
        <div class="invoice-pay-box">
          <div class="title">Catatan</div>
          <div>Dokumen ini menandakan harga sudah disepakati. Invoice resmi akan dicetak setelah barang dikirim.</div>
        </div>
        <div class="invoice-total-box">
          <div class="row total"><span>Total Disetujui</span><span>${formatRupiah(total)}</span></div>
        </div>
      </div>
    </div>
  `;
  printReport(body, `Persetujuan-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.tanggalPo)}`);
}

function printInvoiceBody(po) {
  const items = po.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${formatDate(po.tanggalPo)}</td>
      <td>${escapeHtml(it.namaBarang)}</td>
      <td>${it.jumlah ?? '-'}</td>
      <td>${escapeHtml(it.satuan || '')}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' ? formatRupiah(it.hargaFinal).replace('Rp ', '') : '-'}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' && it.jumlah ? formatRupiah(it.hargaFinal * it.jumlah).replace('Rp ', '') : '-'}</td>
    </tr>
  `).join('');

  const subtotal = poTotal(po);
  const setelahPotongan = Math.round(subtotal * (1 - (po.invoicePotongan || 0) / 100));
  const total = Math.round(setelahPotongan * (1 + (po.invoicePpn || 0) / 100));

  const body = `
    <div class="invoice-head">
      ${invoiceHeadCompanyHtml()}
      <div class="invoice-title">INVOICE</div>
    </div>
    <div class="invoice-to-row">
      <div class="to">To: <b>${escapeHtml(po.tujuanSppg)}</b></div>
      <div class="meta-right">
        <div class="row"><span class="lbl">Tanggal:</span> ${formatDate(po.invoiceTanggal)}</div>
        <div class="row"><span class="lbl">Nomor:</span> ${escapeHtml(po.invoiceNomor)}</div>
      </div>
    </div>
    <table class="invoice-table">
      <thead><tr><th>No</th><th>Tanggal</th><th>Nama Barang</th><th>Qty</th><th>Satuan</th><th>Harga Satuan</th><th>Nominal</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="invoice-bottom-row">
      <div class="invoice-pay-box">
        <div class="title">Please to be paid to our account as below:</div>
        <div class="pay-row"><span>Name of Bank</span><span>: <b>${escapeHtml(KOPERASI_INFO.bankNama)}</b></span></div>
        <div class="pay-row"><span>Account No.</span><span>: ${escapeHtml(KOPERASI_INFO.bankRekening)}</span></div>
        <div class="pay-row"><span></span><span>: ${escapeHtml(KOPERASI_INFO.bankAtasNama)}</span></div>
      </div>
      <div class="invoice-total-box">
        <div class="row"><span>Subtotal</span><span>${formatRupiah(subtotal)}</span></div>
        <div class="row"><span>Potongan${po.invoicePotongan ? ' (' + po.invoicePotongan + '%)' : ''}</span><span>${po.invoicePotongan ? '-' + formatRupiah(subtotal - setelahPotongan) : '-'}</span></div>
        <div class="row"><span>PPN${po.invoicePpn ? ' (' + po.invoicePpn + '%)' : ''}</span><span>${po.invoicePpn ? formatRupiah(total - setelahPotongan) : '-'}</span></div>
        <div class="row total"><span>Total</span><span>${formatRupiah(total)}</span></div>
      </div>
    </div>
    <div class="invoice-signature">
      <div>Your Sincerely,<br>${escapeHtml(KOPERASI_INFO.namaSingkat)}</div>
      <div class="sig-visual">
        <img class="sig-stempel" src="${STEMPEL_URL}" alt="">
        <img class="sig-ttd" src="${TTD_URL}" alt="">
      </div>
      <div class="sig-name">${escapeHtml(KOPERASI_INFO.penandaTangan)}</div>
    </div>
    <div class="invoice-bottom-rule"></div>
  `;
  printReport(body, `Invoice-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.invoiceTanggal)}`);
}

async function deletePo(id) {
  if (!id) return;
  if (!confirm('Hapus PO ini beserta seluruh barang di dalamnya? Tindakan ini tidak bisa dibatalkan.')) return;
  const po = state.lastPoSppgItems.find(p => p.id === id);
  try {
    await deleteDoc(doc(state.db, 'poSppg', id));
    if (po) {
      logActivity({
        action: 'hapus', modul: 'Koperasi - PO SPPG',
        ringkasan: `Hapus PO dari ${po.tujuanSppg} (${(po.items || []).length} jenis barang, status: ${STATUS_LABEL[po.status] || po.status})`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

function startEditPo(po) {
  editingId = po.id;
  document.getElementById('poTanggal').value = po.tanggalPo || '';
  document.getElementById('poTujuan').value = po.tujuanSppg || '';
  document.getElementById('poCatatan').value = po.catatan || '';

  document.getElementById('poItemRows').innerHTML = '';
  rowCounter = 0;
  const items = po.items || [];
  if (items.length === 0) addItemRow(); else items.forEach(item => addItemRow(item));

  document.getElementById('btnSavePo').textContent = 'Update PO';
  document.getElementById('btnCancelEditPo').classList.remove('hidden');
  document.getElementById('poTujuan').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditPo() {
  editingId = null;
  document.getElementById('poTujuan').value = '';
  document.getElementById('poCatatan').value = '';
  resetItemRows();
  document.getElementById('btnSavePo').textContent = 'Simpan PO';
  document.getElementById('btnCancelEditPo').classList.add('hidden');
}

export async function savePo() {
  const tanggalPo = document.getElementById('poTanggal').value;
  const tujuanSppg = document.getElementById('poTujuan').value.trim();
  const catatan = document.getElementById('poCatatan').value.trim();
  const items = readItemRows();

  if (!tanggalPo || !tujuanSppg) {
    alert('Mohon isi tanggal PO dan tujuan/nama SPPG.');
    return;
  }
  if (items.length === 0 || items.some(it => !it.namaBarang || !it.jumlah || !it.satuan)) {
    alert('Mohon isi nama barang, jumlah, dan satuan untuk setiap baris barang.');
    return;
  }

  const isEdit = !!editingId;
  const entry = { tanggalPo, tujuanSppg, catatan, items };
  if (isEdit) {
    entry.updatedAt = serverTimestamp();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.status = 'menunggu_pembelian';
    entry.distribusiId = null;
    entry.invoiceNomor = null;
    entry.createdAt = serverTimestamp();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSavePo');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'poSppg', editingId), entry);
      logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Update PO dari ${tujuanSppg} (${items.length} jenis barang)` });
      cancelEditPo();
    } else {
      await addDoc(collection(state.db, 'poSppg'), entry);
      logActivity({ action: 'tambah', modul: 'Koperasi - PO SPPG', ringkasan: `PO baru dari ${tujuanSppg} (${items.length} jenis barang)` });
      document.getElementById('poTujuan').value = '';
      document.getElementById('poCatatan').value = '';
      resetItemRows();
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan PO. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update PO' : 'Simpan PO';
  }
}

export function downloadLaporanPo() {
  const dari = document.getElementById('poFilterDari').value;
  const sampai = document.getElementById('poFilterSampai').value;
  const list = filteredPo();

  if (list.length === 0) {
    alert('Tidak ada data PO untuk filter ini.');
    return;
  }

  const headers = ['Tanggal PO', 'Tujuan SPPG', 'Status', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga Satuan Rencana (Rp)', 'Harga Satuan Final (Rp)', 'Subtotal (Rp)', 'Catatan', 'Nomor Invoice', 'Diinput Oleh'];
  const rows = [];
  list.forEach(po => {
    (po.items || []).forEach(item => {
      const subtotal = itemSubtotal(item, typeof item.hargaFinal === 'number');
      rows.push([
        formatDate(po.tanggalPo), po.tujuanSppg, STATUS_LABEL[po.status] || po.status,
        item.namaBarang, item.jumlah ?? '', item.satuan || '', item.hargaRencana ?? '', item.hargaFinal ?? '', subtotal ?? '',
        po.catatan || '', po.invoiceNomor || '', po.createdBy || '',
      ]);
    });
  });

  downloadCsv(`Laporan-PO-SPPG-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initPoSppgEvents() {
  document.getElementById('btnSavePo').addEventListener('click', savePo);
  document.getElementById('btnTambahBarangPo').addEventListener('click', addItemRow);
  document.getElementById('btnCancelEditPo').addEventListener('click', cancelEditPo);
  ['poFilterStatus', 'poFilterDari', 'poFilterSampai'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderPoSppg);
  });
  document.getElementById('btnPoFilterReset').addEventListener('click', () => {
    document.getElementById('poFilterStatus').value = 'all';
    document.getElementById('poFilterDari').value = '';
    document.getElementById('poFilterSampai').value = '';
    renderPoSppg();
  });
  document.getElementById('btnDownloadPo').addEventListener('click', downloadLaporanPo);
  document.getElementById('btnImportArsipPo').addEventListener('click', importArsipLama);
  resetItemRows();
}
