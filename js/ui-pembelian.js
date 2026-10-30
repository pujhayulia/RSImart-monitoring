// ---------- Koperasi Bahan Makanan — Sub-bagian 1: Pembelian dari toko/supplier ----------
// Satu barang yang dibeli = satu dokumen di collection "pembelianBahanMakanan",
// terpisah dari modul Stok Gudang RSI ("rekap"/"pengiriman"/"lokasi").
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, timestampToLocalDateIso, escapeHtml, monthRange } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';
import { cariMasterBarang } from './ui-master-barang.js';

const FIELD_IDS = ['NamaToko', 'NoHp', 'AlamatToko', 'NamaPembeli', 'Catatan'];

let editingId = null;
let rowCounter = 0;
let lengkapiExpandPoId = null; // id PO yang sedang dibuka form "Lengkapi Semua"-nya di daftar riwayat

/** Kunci stabil satu baris barang PO (sama dengan poItemKey() di ui-po-sppg.js, sengaja tidak diimpor supaya kedua modul tidak saling bergantung). */
function poItemKeyLocal(item, index) {
  return item.itemId || ('idx' + index);
}

/** Total sudah dibeli untuk satu barang PO tertentu (opsional: kecualikan satu catatan pembelian, mis. saat sedang diedit).
 * Draft kosong (belum ada toko -- lihat belumLengkap()) TIDAK dihitung sebagai "sudah dibeli", walaupun
 * field jumlah-nya sudah terisi jumlah pesanan penuh -- itu cuma placeholder, belum benar-benar dibeli. */
function jumlahDibeliUntukPoItem(poId, itemId, excludeId) {
  return (state.lastPembelianItems || [])
    .filter(it => it.poId === poId && it.poItemId === itemId && it.id !== excludeId && it.namaToko)
    .reduce((sum, it) => sum + (typeof it.jumlah === 'number' ? it.jumlah : 0), 0);
}

/** Isi ulang dropdown "Kaitkan ke PO" dari PO yang masih berstatus Menunggu Pembelian. */
export function refreshPoOptions() {
  const sel = document.getElementById('pembelianPoId');
  if (!sel) return;
  const current = sel.value;
  const open = (state.lastPoSppgItems || []).filter(po => po.status === 'menunggu_pembelian');
  sel.innerHTML = '<option value="">— Tidak dikaitkan ke PO —</option>' +
    open.map(po => `<option value="${po.id}">${escapeHtml(po.tujuanSppg)} — ${formatDate(po.tanggalPo)}</option>`).join('');
  sel.value = open.some(po => po.id === current) ? current : '';
  refreshAllRowPoItemSelects();
}

/** Isi ulang pilihan "Untuk barang PO ini" di SATU baris barang, berdasarkan PO yang sedang dikaitkan (kalau ada). */
function populateRowPoItemSelect(row) {
  const itemSel = row.querySelector('.nir-poitem');
  if (!itemSel) return;
  const current = itemSel.value;
  const poId = document.getElementById('pembelianPoId').value;
  const po = (state.lastPoSppgItems || []).find(p => p.id === poId);
  if (!po) {
    itemSel.innerHTML = '<option value="">— Tidak dikaitkan ke barang PO tertentu —</option>';
    itemSel.classList.add('hidden');
    return;
  }
  itemSel.classList.remove('hidden');
  const items = po.items || [];
  itemSel.innerHTML = '<option value="">— Untuk barang PO yang mana? —</option>' + items.map((it, idx) => {
    const key = poItemKeyLocal(it, idx);
    const jumlahOrder = typeof it.jumlah === 'number' ? it.jumlah : 0;
    const dibeli = jumlahDibeliUntukPoItem(po.id, key, editingId);
    const sisa = jumlahOrder - dibeli;
    const label = `${it.namaBarang} — ${jumlahOrder} ${it.satuan || ''} dipesan${dibeli > 0 ? `, sisa ${sisa}` : ''}`;
    return `<option value="${key}">${escapeHtml(label)}</option>`;
  }).join('');
  if (items.some((it, idx) => poItemKeyLocal(it, idx) === current)) itemSel.value = current;
}

/** Isi ulang pilihan "Untuk barang PO ini" di SEMUA baris barang yang sedang ditampilkan. */
function refreshAllRowPoItemSelects() {
  document.querySelectorAll('#pembelianItemRows .nota-item-row').forEach(populateRowPoItemSelect);
}

/** Dipanggil saat "Kaitkan ke PO" dipilih (bukan saat mode edit): ganti baris kosong dengan satu baris
 * per barang PO itu, nama/jumlah-sisa/satuan terisi otomatis — supaya tidak perlu ketik & pilih satu-satu.
 * Jumlah yang sudah terbeli (dari pembelian lain yang sudah tercatat) dikurangi dari jumlah pesan; barang
 * yang sudah terbeli penuh tidak dibuatkan baris. Harga sengaja dikosongkan — itu harga beli ke toko,
 * beda dari harga PO (harga jual ke SPPG), jadi tidak bisa diisi otomatis dari PO.
 */
function autoFillRowsFromPo(poId) {
  const po = (state.lastPoSppgItems || []).find(p => p.id === poId);
  document.getElementById('pembelianItemRows').innerHTML = '';
  rowCounter = 0;
  (po?.items || []).forEach((it, idx) => {
    const key = poItemKeyLocal(it, idx);
    const jumlahOrder = typeof it.jumlah === 'number' ? it.jumlah : 0;
    const sisa = jumlahOrder - jumlahDibeliUntukPoItem(po.id, key, editingId);
    if (sisa <= 0) return; // sudah terbeli penuh, tidak perlu baris lagi
    addItemRow({ namaBarang: it.namaBarang, jumlah: sisa, satuan: it.satuan, poItemId: key });
  });
  if (document.getElementById('pembelianItemRows').children.length === 0) addItemRow();
}

/** Saat "Untuk barang PO ini" dipilih di satu baris, isi otomatis nama barang & satuannya dari PO. */
function applyPoItemToRow(row) {
  const itemSel = row.querySelector('.nir-poitem');
  const po = (state.lastPoSppgItems || []).find(p => p.id === document.getElementById('pembelianPoId').value);
  if (!po || !itemSel) return;
  const idx = (po.items || []).findIndex((it, i) => poItemKeyLocal(it, i) === itemSel.value);
  if (idx === -1) return;
  const it = po.items[idx];
  row.querySelector('.nir-nama').value = it.namaBarang || '';
  row.querySelector('.nir-satuan').value = it.satuan || '';
}

function itemRowHtml(rowId) {
  return `
    <div class="nota-item-row" data-rowid="${rowId}">
      <input class="nir-nama" list="masterBarangList" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga (total barang ini)">
        <button type="button" class="nir-remove" data-rowid="${rowId}" title="Hapus baris ini">✕</button>
      </div>
      <select class="nir-poitem hidden"><option value="">— Tidak dikaitkan ke barang PO tertentu —</option></select>
    </div>`;
}

/** Barang yang namanya cocok persis dengan Master Barang: isi otomatis Satuan, dan Harga total
 * (Harga Beli Koperasi per satuan × Jumlah) kalau field-field itu masih kosong. */
function terapkanMasterBarangKeBaris(row) {
  const master = cariMasterBarang(row.querySelector('.nir-nama').value);
  if (!master) return;
  const satuanEl = row.querySelector('.nir-satuan');
  if (!satuanEl.value && master.satuan) satuanEl.value = master.satuan;
  const hargaEl = row.querySelector('.nir-harga');
  const jumlah = Number(row.querySelector('.nir-jumlah').value);
  if (!hargaEl.value && jumlah > 0 && typeof master.hargaBeliKoperasi === 'number') {
    hargaEl.value = Math.round(master.hargaBeliKoperasi * jumlah);
  }
}

function addItemRow(prefill) {
  rowCounter += 1;
  const wrap = document.getElementById('pembelianItemRows');
  wrap.insertAdjacentHTML('beforeend', itemRowHtml(rowCounter));
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowCounter}"]`);
  row.querySelector('.nir-remove').addEventListener('click', () => removeItemRow(rowCounter));
  row.querySelector('.nir-poitem').addEventListener('change', () => applyPoItemToRow(row));
  row.querySelector('.nir-nama').addEventListener('change', () => terapkanMasterBarangKeBaris(row));
  row.querySelector('.nir-jumlah').addEventListener('input', () => terapkanMasterBarangKeBaris(row));
  populateRowPoItemSelect(row);
  if (prefill) {
    row.querySelector('.nir-nama').value = prefill.namaBarang || '';
    row.querySelector('.nir-jumlah').value = prefill.jumlah ?? '';
    row.querySelector('.nir-satuan').value = prefill.satuan || '';
    row.querySelector('.nir-harga').value = prefill.harga ?? '';
    if (prefill.poItemId) row.querySelector('.nir-poitem').value = prefill.poItemId;
  }
}

function removeItemRow(rowId) {
  const wrap = document.getElementById('pembelianItemRows');
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowId}"]`);
  if (row) row.remove();
  if (wrap.children.length === 0) addItemRow();
}

function resetItemRows() {
  document.getElementById('pembelianItemRows').innerHTML = '';
  rowCounter = 0;
  addItemRow();
}

function readItemRows() {
  const rows = document.querySelectorAll('#pembelianItemRows .nota-item-row');
  const items = [];
  rows.forEach(row => {
    const namaBarang = row.querySelector('.nir-nama').value.trim();
    const jumlah = row.querySelector('.nir-jumlah').value;
    const satuan = row.querySelector('.nir-satuan').value.trim();
    const harga = row.querySelector('.nir-harga').value;
    const poItemId = row.querySelector('.nir-poitem').value || null;
    if (!namaBarang && !jumlah && !satuan && !harga) return; // baris kosong, lewati
    items.push({ namaBarang, jumlah, satuan, harga, poItemId });
  });
  return items;
}

function fieldEl(name) {
  return document.getElementById('pembelian' + name);
}

export function watchPembelian(onChange) {
  const logEl = document.getElementById('pembelianLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data pembelian...</div>`;
  // PENTING -- limit() ini menentukan jumlah baca Firestore setiap kali situs dibuka/refresh (paket
  // gratis cuma 50.000 baca/hari total, lihat insiden 2026-10-28/30: koleksi ini sempat ~39.000+
  // dokumen -- kebanyakan draft kosong arsip impor + draft kosong lama yang tak kunjung dilengkapi --
  // bikin SEKALI buka situs saja sudah menghabiskan hampir semua jatah harian). Diturunkan dari 20000
  // ke 6000 setelah pembersihan arsip impor -- tetap jauh lebih tinggi dari jumlah data riil sehari-hari
  // supaya logika "sudah ada pembelian belum" (poItemBelumPunyaPembelian, itemRealisasi/margin, lihat
  // ui-po-sppg.js) tetap lengkap & akurat, tapi membatasi kerusakan kalau koleksi membengkak lagi.
  const q = query(collection(state.db, 'pembelianBahanMakanan'), orderBy('createdAt', 'desc'), limit(6000));
  if (state.pembelianUnsub) state.pembelianUnsub();
  state.pembelianUnsub = onSnapshot(q, (qs) => {
    state.lastPembelianItems = [];
    qs.forEach(d => state.lastPembelianItems.push({ id: d.id, ...d.data() }));
    renderPembelian();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data pembelian.</div>`;
  });
}

/**
 * Tanggal efektif satu pembelian: untuk catatan hasil impor arsip (importBatch terisi),
 * pakai tanggal PO yang ditautkan — createdAt-nya cuma waktu import, bukan tanggal
 * transaksi asli. Pembelian biasa (input manual sehari-hari) tetap pakai createdAt,
 * karena itu memang waktu transaksinya yang sebenarnya (bisa beda dari tanggalPo).
 */
export function pembelianTanggalIso(it) {
  if (it.importBatch && it.poId) {
    const po = (state.lastPoSppgItems || []).find(p => p.id === it.poId);
    if (po && po.tanggalPo) return po.tanggalPo;
  }
  return timestampToLocalDateIso(it.createdAt);
}

/** Versi tampilan (untuk UI/CSV): tanggal arsip ditampilkan tanpa jam (jamnya tidak relevan), pembelian biasa tetap dengan jam. */
export function pembelianTanggalDisplay(it) {
  if (it.importBatch) return formatDate(pembelianTanggalIso(it));
  return formatTimestamp(it.createdAt);
}

/** Nama dapur/SPPG tujuan satu pembelian — hanya ada kalau pembelian ini dikaitkan ke sebuah PO (dapur
 * bukan field milik Pembelian sendiri, karena satu pembelian bisa jadi stok umum, bukan untuk SPPG tertentu). */
function dapurUntukPembelian(it) {
  const po = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
  return po ? po.tujuanSppg : '';
}

/** Draft otomatis dari PO yang belum dilengkapi tim lapangan — belum ada nama toko sama sekali. */
function belumLengkap(it) {
  return !it.namaToko;
}

/** true kalau catatan ini berasal dari arsip impor massal (langsung ditandai importBatch, ATAU
 * backfill draft dari PO lama yang PO-nya sendiri bertanda arsip) -- bukan diinput manual hari-hari
 * biasa. Dipakai supaya data baru tidak "tertimbun" ribuan catatan arsip secara default. */
function pembelianIsArsip(it) {
  if (it.importBatch) return true;
  const po = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
  return !!(po && po.importBatch);
}

/** Cari catatan Pembelian duplikat untuk barang PO yang sama (poId+poItemId sama) -- muncul akibat
 * klik tombol "Tambahkan ke Pembelian Sekarang" berulang kali sebelum limit() query diperbaiki.
 * Hanya kelompok yang AMAN dibersihkan yang dikembalikan: kalau ada 2+ catatan dengan toko/harga
 * yang SUDAH diisi dalam satu kelompok, itu dianggap pembelian ganda yang sah (bukan duplikat kosong)
 * dan dilewati -- tidak pernah ikut dihapus. */
function cariDuplikatPembelian() {
  const groups = new Map();
  state.lastPembelianItems.forEach(it => {
    if (!it.poId || !it.poItemId) return;
    const key = it.poId + '::' + it.poItemId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  });
  const idsToDelete = [];
  groups.forEach(items => {
    if (items.length <= 1) return;
    const terisi = items.filter(it => it.namaToko || typeof it.harga === 'number');
    if (terisi.length >= 2) return; // ada 2+ catatan nyata berbeda -- bukan duplikat sederhana, lewati
    const keep = terisi.length === 1 ? terisi[0] : items[0];
    items.forEach(it => { if (it.id !== keep.id) idsToDelete.push(it.id); });
  });
  return idsToDelete;
}

async function bersihkanDuplikatPembelian() {
  const idsToDelete = cariDuplikatPembelian();
  if (idsToDelete.length === 0) return;
  if (!confirm(`Ditemukan ${idsToDelete.length} catatan duplikat kosong untuk barang PO yang sama (sisa klik tombol backfill berulang). Hapus sekarang? Catatan yang sudah diisi toko/harga TIDAK akan dihapus.`)) return;

  const btn = document.getElementById('btnBersihkanDuplikatPembelian');
  if (btn) { btn.disabled = true; btn.textContent = 'Menghapus...'; }
  try {
    for (let i = 0; i < idsToDelete.length; i += 450) {
      const batch = writeBatch(state.db);
      idsToDelete.slice(i, i + 450).forEach(id => batch.delete(doc(state.db, 'pembelianBahanMakanan', id)));
      await batch.commit();
    }
    logActivity({ action: 'hapus', modul: 'Koperasi - Pembelian', ringkasan: `Bersihkan ${idsToDelete.length} catatan duplikat kosong (sisa klik backfill berulang)` });
    alert(`Selesai. ${idsToDelete.length} catatan duplikat berhasil dihapus.`);
  } catch (e) {
    console.error('Gagal membersihkan duplikat', e);
    alert('Gagal menghapus duplikat. Pastikan Anda sudah login.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Hapus Duplikat Sekarang'; }
    renderPembelian(); // segarkan banner (jumlahnya sekarang harus 0 kalau berhasil)
  }
}

function filteredPembelian() {
  const tampilkanArsip = document.getElementById('pembelianFilterArsip').checked;
  const dari = document.getElementById('pembelianFilterDari').value;
  const sampai = document.getElementById('pembelianFilterSampai').value;
  const dapur = document.getElementById('pembelianFilterDapur').value.trim().toLowerCase();
  const hanyaBelumLengkap = document.getElementById('pembelianFilterBelumLengkap').checked;
  return state.lastPembelianItems.filter(it => {
    if (!tampilkanArsip && pembelianIsArsip(it)) return false;
    if (hanyaBelumLengkap) return belumLengkap(it); // abaikan filter tanggal — jangan sampai ada draft lama yang tersembunyi
    if ((dari || sampai) && !isDateStrInRange(pembelianTanggalIso(it), dari, sampai)) return false;
    if (dapur && !dapurUntukPembelian(it).toLowerCase().includes(dapur)) return false;
    return true;
  });
}

/** Total belanja & jumlah transaksi dalam rentang tanggal (kosongkan dari/sampai untuk semua data) — dipakai di Beranda Koperasi.
 * Draft otomatis dari PO yang belum dilengkapi tim lapangan TIDAK dihitung — belum benar-benar jadi transaksi pembelian. */
export function computePembelianSummary(dari, sampai) {
  const all = (!dari && !sampai) ? state.lastPembelianItems : state.lastPembelianItems.filter(it => isDateStrInRange(pembelianTanggalIso(it), dari, sampai));
  const items = all.filter(it => !belumLengkap(it));
  let totalBelanja = 0;
  items.forEach(it => { totalBelanja += typeof it.harga === 'number' ? it.harga : 0; });
  return { totalBelanja, jumlahTransaksi: items.length };
}

/** Isi ulang datalist "Nama Toko" dari nama-nama toko unik yang pernah dipakai — tanpa collection Firestore terpisah. */
/** Datalist nama toko: gabungan nama toko yang pernah dipakai di Pembelian + daftar di Data Supplier —
 * supaya toko yang sudah terdaftar di Data Supplier langsung bisa diketik cepat juga di sini. */
function refreshTokoOptions() {
  const list = document.getElementById('tokoList');
  if (!list) return;
  const seen = new Set();
  const names = [];
  const tambah = (nama) => {
    const n = (nama || '').trim();
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
  };
  state.lastPembelianItems.forEach(it => tambah(it.namaToko));
  (state.lastSupplierItems || []).forEach(it => tambah(it.namaTokoUsaha));
  names.sort((a, b) => a.localeCompare(b));
  list.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">`).join('');
}

function tsToMillis(ts) {
  if (!ts) return 0;
  return (typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)).getTime();
}

/** Kelompokkan catatan Pembelian yang tertaut ke PO yang sama jadi satu kartu (seperti kartu PO dari
 * SPPG) — tim lapangan lihat satu kartu per PO/dapur, bukan satu kartu terpisah per barang. Pembelian
 * tanpa PO (belanja stok umum) tetap tampil sebagai kartu sendiri-sendiri seperti sebelumnya. */
function groupPembelianItems(items) {
  const groups = new Map(); // poId -> { po, items: [] }
  const flat = [];
  items.forEach(it => {
    const po = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
    if (!po) { flat.push({ sortKey: tsToMillis(it.createdAt), html: distItemCardHtml(it) }); return; }
    if (!groups.has(po.id)) groups.set(po.id, { po, items: [] });
    groups.get(po.id).items.push(it);
  });
  const grouped = [...groups.values()].map(g => ({
    sortKey: Math.max(...g.items.map(it => tsToMillis(it.createdAt))),
    html: poGroupCardHtml(g.po, g.items),
  }));
  return [...grouped, ...flat].sort((a, b) => b.sortKey - a.sortKey).map(x => x.html);
}

/** Satu kartu pembelian ad-hoc (tidak tertaut PO manapun) — layout lama, tak berubah. */
function distItemCardHtml(it) {
  const draft = belumLengkap(it);
  const infoToko = draft
    ? `<div class="meta belum-lengkap-badge">⚠️ Perlu Dilengkapi — belum ada toko &amp; harga</div>`
    : `<div class="meta">${escapeHtml(it.namaToko)}${it.noHpToko ? ' · ' + escapeHtml(it.noHpToko) : ''}</div>
       <div class="meta">${escapeHtml(it.alamatToko || '-')}</div>
       <div class="meta">Dibeli oleh ${escapeHtml(it.namaPembeli)} · ${pembelianTanggalDisplay(it)}</div>`;
  return `
    <div class="dist-item${draft ? ' dist-item-draft' : ''}" data-pembelianitem="${it.id}">
      <div class="left">
        <b>${escapeHtml(it.namaBarang)}</b>
        ${infoToko}
        ${it.catatan ? `<div class="meta">Catatan: ${escapeHtml(it.catatan)}</div>` : ''}
        ${it.createdBy ? `<div class="meta">Diinput oleh ${escapeHtml(it.createdBy)}</div>` : ''}
      </div>
      <div class="right">
        <div class="qty">${it.jumlah} ${escapeHtml(it.satuan)}</div>
        <div class="dist-item-total">${formatRupiah(it.harga)}</div>
        <div class="dist-item-actions">
          ${draft ? `<button class="btn lengkapi-btn" data-editid="${it.id}" title="Isi toko &amp; harga beli">Lengkapi</button>` : ''}
          <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>`;
}

/** Satu kartu pembelian yang tertaut ke sebuah PO — dibuat semirip mungkin dengan kartu PO dari SPPG
 * (reuse class .po-card dkk) supaya tampilannya konsisten dan langsung dikenali sebagai "satu PO". */
function poGroupCardHtml(po, items) {
  const draftItems = items.filter(belumLengkap);
  const semuaLengkap = draftItems.length === 0;
  const badge = semuaLengkap
    ? `<span class="po-status-badge po-status-badge--disetujui">✓ Lengkap</span>`
    : `<span class="po-status-badge po-status-badge--ditolak">⚠️ ${draftItems.length} Perlu Dilengkapi</span>`;

  const itemsHtml = items.map(it => {
    const draft = belumLengkap(it);
    const hargaLabel = draft ? `<span class="belum-lengkap-badge">Perlu Dilengkapi</span>` : formatRupiah(it.harga);
    const tokoLabel = draft ? '' : ` <span class="nota-detail-toko">· ${escapeHtml(it.namaToko)}</span>`;
    return `
    <div class="nota-detail-row nota-detail-row--pembelian">
      <span class="nota-detail-nama">${escapeHtml(it.namaBarang)}${tokoLabel}</span>
      <span class="nota-detail-qty">${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
      <span class="nota-detail-harga">${hargaLabel}</span>
      <span class="nota-detail-actions">
        <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
        <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
      </span>
    </div>`;
  }).join('');

  const totalSelesai = items.filter(it => !belumLengkap(it)).reduce((s, it) => s + (typeof it.harga === 'number' ? it.harga : 0), 0);

  return `
    <div class="po-card" data-pembeliangroup="${po.id}">
      <div class="po-card-head">
        <div>
          <b>${escapeHtml(po.tujuanSppg)}</b>
          <div class="meta">PO: ${formatDate(po.tanggalPo)} · ${items.length} jenis barang</div>
        </div>
        ${badge}
      </div>
      <div class="po-card-items">${itemsHtml}</div>
      ${totalSelesai > 0 ? `<div class="po-card-total">Total (yang selesai): ${formatRupiah(totalSelesai)}</div>` : ''}
      ${lengkapiExpandPoId === po.id ? lengkapiSemuaFormHtml(po, draftItems) : ''}
      <div class="po-card-actions">
        ${!semuaLengkap && lengkapiExpandPoId !== po.id ? `<button type="button" class="btn" data-lengkapisemua="${po.id}">Lengkapi Semua (${draftItems.length})</button>` : ''}
      </div>
    </div>`;
}

function lengkapiSemuaFormHtml(po, draftItems) {
  const rows = draftItems.map(it => {
    const master = cariMasterBarang(it.namaBarang);
    const saran = master && typeof master.hargaBeliKoperasi === 'number' && typeof it.jumlah === 'number'
      ? Math.round(master.hargaBeliKoperasi * it.jumlah) : '';
    return `
    <div class="po-inline-row">
      <span>${escapeHtml(it.namaBarang)}</span>
      <span>${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
      <input type="number" class="lengkapi-harga" data-pembelianid="${it.id}" placeholder="Harga beli" min="0" value="${saran}">
    </div>`;
  }).join('');
  return `
    <div class="po-inline-form" data-lengkapiform="${po.id}">
      <h4>Isi info toko (berlaku untuk semua barang di bawah yang diisi harganya), lalu Simpan:</h4>
      <div class="form-grid">
        <input id="lengkapiNamaToko-${po.id}" list="tokoList" placeholder="Nama Toko">
        <input id="lengkapiNoHp-${po.id}" type="tel" placeholder="No. HP Toko (opsional)">
        <input id="lengkapiAlamat-${po.id}" placeholder="Alamat Toko">
        <input id="lengkapiPembeli-${po.id}" placeholder="Nama Pembeli">
      </div>
      <h4>Harga per barang (kosongkan barang yang tidak dibeli di toko ini) — angka yang sudah terisi hanya saran dari Master Barang, cek &amp; sesuaikan dengan harga beli sebenarnya:</h4>
      ${rows}
      <div class="po-inline-form-actions">
        <button type="button" class="btn-ghost" data-lengkapicancel="${po.id}">Batal</button>
        <button type="button" class="btn" data-lengkapisave="${po.id}">Simpan</button>
      </div>
    </div>`;
}

async function simpanLengkapiSemua(poId) {
  const namaToko = document.getElementById(`lengkapiNamaToko-${poId}`).value.trim();
  const noHpToko = document.getElementById(`lengkapiNoHp-${poId}`).value.trim();
  const alamatToko = document.getElementById(`lengkapiAlamat-${poId}`).value.trim();
  const namaPembeli = document.getElementById(`lengkapiPembeli-${poId}`).value.trim();
  const hargaInputs = [...document.querySelectorAll(`[data-lengkapiform="${poId}"] .lengkapi-harga`)]
    .map(inp => ({ id: inp.dataset.pembelianid, val: inp.value }))
    .filter(x => x.val !== '');

  if (hargaInputs.length === 0) { alert('Isi harga minimal satu barang dulu — kosongkan baris barang yang memang belum/tidak dibeli di toko ini.'); return; }
  if (!namaToko || !alamatToko || !namaPembeli) { alert('Mohon isi nama toko, alamat toko, dan nama pembeli.'); return; }
  if (hargaInputs.some(x => isNaN(Number(x.val)) || Number(x.val) < 0)) { alert('Harga tidak valid.'); return; }

  const btn = document.querySelector(`[data-lengkapisave="${poId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
  try {
    const batch = writeBatch(state.db);
    hargaInputs.forEach(({ id, val }) => {
      batch.update(doc(state.db, 'pembelianBahanMakanan', id), {
        namaToko, noHpToko, alamatToko, namaPembeli, harga: Number(val),
        // Sama seperti di savePembelian(): draft ini createdAt-nya masih waktu PO dibuat, timpa
        // dengan waktu pelengkapan supaya muncul di filter tanggal hari ini.
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
      });
    });
    await batch.commit();
    const po = state.lastPoSppgItems.find(p => p.id === poId);
    logActivity({
      action: 'ubah', modul: 'Koperasi - Pembelian',
      ringkasan: `Lengkapi ${hargaInputs.length} barang dari PO ${po ? po.tujuanSppg : poId} di Toko ${namaToko}`,
    });
    lengkapiExpandPoId = null;
    renderPembelian();
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
    if (btn) { btn.disabled = false; btn.textContent = 'Simpan'; }
  }
}

export function renderPembelian() {
  refreshTokoOptions();
  const logEl = document.getElementById('pembelianLog');
  const items = filteredPembelian();

  // "Transaksi" = pembelian yang sudah benar-benar terjadi (toko & harga terisi) — draft yang masih
  // menunggu dilengkapi tim lapangan belum dihitung, supaya totalnya tidak menyesatkan.
  const itemsSelesai = items.filter(it => !belumLengkap(it));
  let totalBelanja = 0;
  itemsSelesai.forEach(it => { totalBelanja += typeof it.harga === 'number' ? it.harga : 0; });
  const totalBelanjaEl = document.getElementById('pembelianTotalBelanja');
  const totalTransaksiEl = document.getElementById('pembelianTotalTransaksi');
  if (totalBelanjaEl) totalBelanjaEl.textContent = formatRupiah(totalBelanja);
  if (totalTransaksiEl) totalTransaksiEl.textContent = String(itemsSelesai.length);

  // Dihitung dari SEMUA data (bukan yang difilter) — supaya draft lama tidak ketinggalan dari pandangan.
  const belumLengkapEl = document.getElementById('pembelianBelumLengkap');
  if (belumLengkapEl) belumLengkapEl.textContent = String(state.lastPembelianItems.filter(belumLengkap).length);

  const arsipCount = state.lastPembelianItems.filter(pembelianIsArsip).length;
  const arsipLabelEl = document.getElementById('pembelianFilterArsipLabel');
  if (arsipLabelEl) arsipLabelEl.textContent = `📁 Tampilkan Arsip (${arsipCount})`;

  const duplikatBar = document.getElementById('pembelianDuplikatBar');
  if (duplikatBar) {
    const duplikatCount = cariDuplikatPembelian().length;
    duplikatBar.classList.toggle('hidden', duplikatCount === 0);
    const btnEl = document.getElementById('btnBersihkanDuplikatPembelian');
    if (btnEl && !btnEl.disabled) {
      document.getElementById('pembelianDuplikatText').textContent =
        `⚠️ Ditemukan ${duplikatCount} catatan duplikat kosong untuk barang PO yang sama (sisa klik tombol backfill berulang).`;
    }
  }

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada catatan pembelian untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = groupPembelianItems(items).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deletePembelian(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn, button.lengkapi-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastPembelianItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditPembelian(item);
    });
  });
  logEl.querySelectorAll('[data-lengkapisemua]').forEach(btn => {
    btn.addEventListener('click', () => { lengkapiExpandPoId = btn.dataset.lengkapisemua; renderPembelian(); });
  });
  logEl.querySelectorAll('[data-lengkapicancel]').forEach(btn => {
    btn.addEventListener('click', () => { lengkapiExpandPoId = null; renderPembelian(); });
  });
  logEl.querySelectorAll('[data-lengkapisave]').forEach(btn => {
    btn.addEventListener('click', () => simpanLengkapiSemua(btn.dataset.lengkapisave));
  });
}

function startEditPembelian(item) {
  editingId = item.id;
  fieldEl('NamaToko').value = item.namaToko || '';
  fieldEl('NoHp').value = item.noHpToko || '';
  fieldEl('AlamatToko').value = item.alamatToko || '';
  fieldEl('NamaPembeli').value = item.namaPembeli || '';
  fieldEl('Catatan').value = item.catatan || '';

  document.getElementById('pembelianPoId').value = item.poId || '';
  document.getElementById('pembelianItemRows').innerHTML = '';
  rowCounter = 0;
  addItemRow({ namaBarang: item.namaBarang, jumlah: item.jumlah, satuan: item.satuan, harga: item.harga, poItemId: item.poItemId });

  // Mengedit selalu satu barang (satu dokumen) — tombol tambah baris disembunyikan selama mode edit ini.
  document.getElementById('btnTambahBarangPembelian').classList.add('hidden');

  document.getElementById('btnSavePembelian').textContent = 'Update Pembelian';
  document.getElementById('btnCancelEditPembelian').classList.remove('hidden');
  fieldEl('NamaToko').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditPembelian() {
  editingId = null;
  for (const name of FIELD_IDS) fieldEl(name).value = '';
  document.getElementById('pembelianPoId').value = '';
  resetItemRows();
  document.getElementById('btnTambahBarangPembelian').classList.remove('hidden');
  document.getElementById('btnSavePembelian').textContent = 'Simpan Pembelian';
  document.getElementById('btnCancelEditPembelian').classList.add('hidden');
}

async function deletePembelian(id) {
  if (!id) return;
  if (!confirm('Hapus catatan pembelian ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastPembelianItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'pembelianBahanMakanan', id));
    if (item) {
      logActivity({
        action: 'hapus',
        modul: 'Koperasi - Pembelian',
        ringkasan: `Hapus pembelian ${item.jumlah} ${item.satuan} ${item.namaBarang} dari ${item.namaToko} (${formatRupiah(item.harga)})`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function savePembelian() {
  const values = {};
  for (const name of FIELD_IDS) values[name] = fieldEl(name).value.trim();

  // Nama toko, alamat, pembeli, dan harga boleh dikosongkan -- pembelian tetap bisa disimpan sebagai
  // "Perlu Dilengkapi" (lihat belumLengkap()) dan diedit lagi nanti saat info toko/harga sudah ada.
  const rows = readItemRows();
  if (rows.length === 0) {
    alert('Mohon isi minimal satu barang (nama, jumlah, dan satuan).');
    return;
  }
  const rowTakLengkap = rows.find(r => !r.namaBarang || !r.jumlah || !r.satuan);
  if (rowTakLengkap) {
    alert(`Mohon lengkapi nama, jumlah, dan satuan untuk barang "${rowTakLengkap.namaBarang || '(belum diisi)'}".`);
    return;
  }

  const poId = document.getElementById('pembelianPoId').value || null;
  const toko = {
    namaToko: values.NamaToko,
    noHpToko: values.NoHp,
    alamatToko: values.AlamatToko,
    namaPembeli: values.NamaPembeli,
    catatan: values.Catatan,
  };
  const isEdit = !!editingId;

  const btn = document.getElementById('btnSavePembelian');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      const r = rows[0];
      const entry = {
        ...toko,
        namaBarang: r.namaBarang, jumlah: Number(r.jumlah), satuan: r.satuan, harga: r.harga ? Number(r.harga) : null,
        poId, poItemId: poId ? r.poItemId : null,
        updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
      };
      await updateDoc(doc(state.db, 'pembelianBahanMakanan', editingId), entry);
      logActivity({
        action: 'ubah',
        modul: 'Koperasi - Pembelian',
        ringkasan: `Update pembelian ${entry.jumlah} ${entry.satuan} ${entry.namaBarang} dari ${entry.namaToko || '(toko belum diisi)'} (${entry.harga === null ? 'harga belum diisi' : formatRupiah(entry.harga)})`,
      });
      cancelEditPembelian();
    } else {
      // Kalau barang ini sudah punya draft kosong dari PO (poId+poItemId sama, belum ada toko), lengkapi
      // draft itu langsung -- JANGAN buat dokumen baru, supaya tidak dobel (lihat cariDuplikatPembelian()).
      const batch = writeBatch(state.db);
      rows.forEach(r => {
        const itemPoId = poId ? r.poItemId : null;
        const draftLama = itemPoId
          ? state.lastPembelianItems.find(it => it.poId === poId && it.poItemId === itemPoId && !it.namaToko)
          : null;
        const data = {
          ...toko,
          namaBarang: r.namaBarang, jumlah: Number(r.jumlah), satuan: r.satuan, harga: r.harga ? Number(r.harga) : null,
          poId, poItemId: itemPoId,
        };
        if (draftLama) {
          // Draft lama createdAt-nya = waktu PO dibuat (cuma placeholder), bukan waktu pembelian ini
          // benar-benar disimpan -- timpa createdAt juga, supaya catatan ini muncul di filter tanggal
          // hari ini, bukan "hilang" karena tersembunyi di tanggal PO dibuat.
          batch.update(doc(state.db, 'pembelianBahanMakanan', draftLama.id), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail });
        } else {
          const ref = doc(collection(state.db, 'pembelianBahanMakanan'));
          batch.set(ref, { ...data, createdAt: serverTimestamp(), createdBy: state.currentUserEmail });
        }
      });
      await batch.commit();
      const totalHarga = rows.reduce((s, r) => s + (r.harga ? Number(r.harga) : 0), 0);
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Pembelian',
        ringkasan: rows.length === 1
          ? `Beli ${Number(rows[0].jumlah)} ${rows[0].satuan} ${rows[0].namaBarang} dari ${toko.namaToko || '(toko belum diisi)'} (${rows[0].harga ? formatRupiah(Number(rows[0].harga)) : 'harga belum diisi'})`
          : `Beli ${rows.length} barang dari ${toko.namaToko || '(toko belum diisi)'} (${formatRupiah(totalHarga)})`,
      });
      for (const name of FIELD_IDS) fieldEl(name).value = '';
      document.getElementById('pembelianPoId').value = '';
      resetItemRows();
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan data pembelian. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Pembelian' : 'Simpan Pembelian';
  }
}

export function downloadLaporanPembelian() {
  const dari = document.getElementById('pembelianFilterDari').value;
  const sampai = document.getElementById('pembelianFilterSampai').value;
  const items = filteredPembelian();

  if (items.length === 0) {
    alert('Tidak ada data pembelian untuk filter ini.');
    return;
  }

  const headers = ['Status', 'Tanggal', 'Nama Toko', 'No. HP Toko', 'Alamat Toko', 'Nama Pembeli', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga (Rp)', 'Untuk PO', 'Catatan', 'Diinput Oleh'];
  const rows = items.map(it => {
    const linkedPo = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
    return [
      belumLengkap(it) ? 'PERLU DILENGKAPI' : 'Selesai',
      pembelianTanggalDisplay(it), it.namaToko, it.noHpToko || '', it.alamatToko || '',
      it.namaPembeli, it.namaBarang, it.jumlah, it.satuan, it.harga,
      linkedPo ? `${linkedPo.tujuanSppg} (${formatDate(linkedPo.tanggalPo)})` : '',
      it.catatan || '', it.createdBy || '',
    ];
  });

  let total = 0;
  items.forEach(it => { total += typeof it.harga === 'number' ? it.harga : 0; });
  rows.push([]);
  rows.push(['', 'TOTAL PENGELUARAN', '', '', '', '', '', '', '', total]);

  downloadCsv(`Laporan-Pembelian-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initPembelianEvents() {
  document.getElementById('btnSavePembelian').addEventListener('click', savePembelian);
  document.getElementById('btnTambahBarangPembelian').addEventListener('click', () => addItemRow());
  document.getElementById('btnBersihkanDuplikatPembelian').addEventListener('click', bersihkanDuplikatPembelian);
  const { dari, sampai } = monthRange();
  document.getElementById('pembelianFilterDari').value = dari;
  document.getElementById('pembelianFilterSampai').value = sampai;
  document.getElementById('pembelianFilterDari').addEventListener('change', renderPembelian);
  document.getElementById('pembelianFilterSampai').addEventListener('change', renderPembelian);
  document.getElementById('pembelianFilterDapur').addEventListener('input', renderPembelian);
  document.getElementById('pembelianFilterBelumLengkap').addEventListener('change', renderPembelian);
  document.getElementById('pembelianFilterArsip').addEventListener('change', renderPembelian);
  document.getElementById('pembelianBelumLengkap').closest('.total-card').addEventListener('click', () => {
    const cb = document.getElementById('pembelianFilterBelumLengkap');
    cb.checked = !cb.checked;
    renderPembelian();
  });
  document.getElementById('btnPembelianFilterReset').addEventListener('click', () => {
    document.getElementById('pembelianFilterDari').value = '';
    document.getElementById('pembelianFilterSampai').value = '';
    document.getElementById('pembelianFilterDapur').value = '';
    document.getElementById('pembelianFilterBelumLengkap').checked = false;
    document.getElementById('pembelianFilterArsip').checked = false;
    renderPembelian();
  });
  document.getElementById('btnDownloadPembelian').addEventListener('click', downloadLaporanPembelian);
  document.getElementById('btnCancelEditPembelian').addEventListener('click', cancelEditPembelian);
  document.getElementById('pembelianPoId').addEventListener('change', () => {
    if (editingId) { refreshAllRowPoItemSelects(); return; } // mode edit: tetap satu baris, jangan ganti jadi banyak
    const poId = document.getElementById('pembelianPoId').value;
    if (poId) autoFillRowsFromPo(poId); else resetItemRows();
  });
  resetItemRows();
  refreshPoOptions();
}
