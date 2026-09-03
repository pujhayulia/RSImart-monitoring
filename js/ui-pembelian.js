// ---------- Koperasi Bahan Makanan — Sub-bagian 1: Pembelian dari toko/supplier ----------
// Satu barang yang dibeli = satu dokumen di collection "pembelianBahanMakanan",
// terpisah dari modul Stok Gudang RSI ("rekap"/"pengiriman"/"lokasi").
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, timestampToLocalDateIso, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

const FIELD_IDS = ['NamaToko', 'NoHp', 'AlamatToko', 'NamaPembeli', 'Catatan'];

let editingId = null;
let rowCounter = 0;

/** Kunci stabil satu baris barang PO (sama dengan poItemKey() di ui-po-sppg.js, sengaja tidak diimpor supaya kedua modul tidak saling bergantung). */
function poItemKeyLocal(item, index) {
  return item.itemId || ('idx' + index);
}

/** Total sudah dibeli untuk satu barang PO tertentu (opsional: kecualikan satu catatan pembelian, mis. saat sedang diedit). */
function jumlahDibeliUntukPoItem(poId, itemId, excludeId) {
  return (state.lastPembelianItems || [])
    .filter(it => it.poId === poId && it.poItemId === itemId && it.id !== excludeId)
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
      <input class="nir-nama" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga (total barang ini)">
        <button type="button" class="nir-remove" data-rowid="${rowId}" title="Hapus baris ini">✕</button>
      </div>
      <select class="nir-poitem hidden"><option value="">— Tidak dikaitkan ke barang PO tertentu —</option></select>
    </div>`;
}

function addItemRow(prefill) {
  rowCounter += 1;
  const wrap = document.getElementById('pembelianItemRows');
  wrap.insertAdjacentHTML('beforeend', itemRowHtml(rowCounter));
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowCounter}"]`);
  row.querySelector('.nir-remove').addEventListener('click', () => removeItemRow(rowCounter));
  row.querySelector('.nir-poitem').addEventListener('change', () => applyPoItemToRow(row));
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
  const q = query(collection(state.db, 'pembelianBahanMakanan'), orderBy('createdAt', 'desc'), limit(500));
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

function filteredPembelian() {
  const dari = document.getElementById('pembelianFilterDari').value;
  const sampai = document.getElementById('pembelianFilterSampai').value;
  if (!dari && !sampai) return state.lastPembelianItems;
  return state.lastPembelianItems.filter(it => isDateStrInRange(pembelianTanggalIso(it), dari, sampai));
}

/** Total belanja & jumlah transaksi dalam rentang tanggal (kosongkan dari/sampai untuk semua data) — dipakai di Beranda Koperasi. */
export function computePembelianSummary(dari, sampai) {
  const items = (!dari && !sampai) ? state.lastPembelianItems : state.lastPembelianItems.filter(it => isDateStrInRange(pembelianTanggalIso(it), dari, sampai));
  let totalBelanja = 0;
  items.forEach(it => { totalBelanja += typeof it.harga === 'number' ? it.harga : 0; });
  return { totalBelanja, jumlahTransaksi: items.length };
}

/** Isi ulang datalist "Nama Toko" dari nama-nama toko unik yang pernah dipakai — tanpa collection Firestore terpisah. */
function refreshTokoOptions() {
  const list = document.getElementById('tokoList');
  if (!list) return;
  const seen = new Set();
  const names = [];
  state.lastPembelianItems.forEach(it => {
    const nama = (it.namaToko || '').trim();
    if (nama && !seen.has(nama.toLowerCase())) {
      seen.add(nama.toLowerCase());
      names.push(nama);
    }
  });
  names.sort((a, b) => a.localeCompare(b));
  list.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">`).join('');
}

export function renderPembelian() {
  refreshTokoOptions();
  const logEl = document.getElementById('pembelianLog');
  const items = filteredPembelian();

  let totalBelanja = 0;
  items.forEach(it => { totalBelanja += typeof it.harga === 'number' ? it.harga : 0; });
  const totalBelanjaEl = document.getElementById('pembelianTotalBelanja');
  const totalTransaksiEl = document.getElementById('pembelianTotalTransaksi');
  if (totalBelanjaEl) totalBelanjaEl.textContent = formatRupiah(totalBelanja);
  if (totalTransaksiEl) totalTransaksiEl.textContent = String(items.length);

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada catatan pembelian untuk rentang tanggal ini.</div>`;
    return;
  }

  logEl.innerHTML = items.map(it => {
    const linkedPo = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
    return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.namaBarang)}</b>
        <div class="meta">${escapeHtml(it.namaToko)}${it.noHpToko ? ' · ' + escapeHtml(it.noHpToko) : ''}</div>
        <div class="meta">${escapeHtml(it.alamatToko || '-')}</div>
        <div class="meta">Dibeli oleh ${escapeHtml(it.namaPembeli)} · ${pembelianTanggalDisplay(it)}</div>
        ${it.catatan ? `<div class="meta">Catatan: ${escapeHtml(it.catatan)}</div>` : ''}
        ${it.createdBy ? `<div class="meta">Diinput oleh ${escapeHtml(it.createdBy)}</div>` : ''}
        ${linkedPo ? `<div class="meta">🔗 Untuk PO: ${escapeHtml(linkedPo.tujuanSppg)} (${formatDate(linkedPo.tanggalPo)})</div>` : ''}
      </div>
      <div class="right">
        <div class="qty">${it.jumlah} ${escapeHtml(it.satuan)}</div>
        <div class="dist-item-total">${formatRupiah(it.harga)}</div>
        <div class="dist-item-actions">
          <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deletePembelian(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastPembelianItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditPembelian(item);
    });
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

  if (!values.NamaToko || !values.AlamatToko || !values.NamaPembeli) {
    alert('Mohon isi nama toko, alamat toko, dan nama pembeli.');
    return;
  }

  const rows = readItemRows();
  if (rows.length === 0) {
    alert('Mohon isi minimal satu barang (nama, jumlah, satuan, dan harga).');
    return;
  }
  const rowTakLengkap = rows.find(r => !r.namaBarang || !r.jumlah || !r.satuan || !r.harga);
  if (rowTakLengkap) {
    alert(`Mohon lengkapi nama, jumlah, satuan, dan harga untuk barang "${rowTakLengkap.namaBarang || '(belum diisi)'}".`);
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
        namaBarang: r.namaBarang, jumlah: Number(r.jumlah), satuan: r.satuan, harga: Number(r.harga),
        poId, poItemId: poId ? r.poItemId : null,
        updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
      };
      await updateDoc(doc(state.db, 'pembelianBahanMakanan', editingId), entry);
      logActivity({
        action: 'ubah',
        modul: 'Koperasi - Pembelian',
        ringkasan: `Update pembelian ${entry.jumlah} ${entry.satuan} ${entry.namaBarang} dari ${entry.namaToko} (${formatRupiah(entry.harga)})`,
      });
      cancelEditPembelian();
    } else {
      const batch = writeBatch(state.db);
      rows.forEach(r => {
        const ref = doc(collection(state.db, 'pembelianBahanMakanan'));
        batch.set(ref, {
          ...toko,
          namaBarang: r.namaBarang, jumlah: Number(r.jumlah), satuan: r.satuan, harga: Number(r.harga),
          poId, poItemId: poId ? r.poItemId : null,
          createdAt: serverTimestamp(), createdBy: state.currentUserEmail,
        });
      });
      await batch.commit();
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Pembelian',
        ringkasan: rows.length === 1
          ? `Beli ${Number(rows[0].jumlah)} ${rows[0].satuan} ${rows[0].namaBarang} dari ${toko.namaToko} (${formatRupiah(Number(rows[0].harga))})`
          : `Beli ${rows.length} barang dari ${toko.namaToko} (${formatRupiah(rows.reduce((s, r) => s + Number(r.harga), 0))})`,
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
    alert('Tidak ada data pembelian untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal', 'Nama Toko', 'No. HP Toko', 'Alamat Toko', 'Nama Pembeli', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga (Rp)', 'Untuk PO', 'Catatan', 'Diinput Oleh'];
  const rows = items.map(it => {
    const linkedPo = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
    return [
      pembelianTanggalDisplay(it), it.namaToko, it.noHpToko || '', it.alamatToko || '',
      it.namaPembeli, it.namaBarang, it.jumlah, it.satuan, it.harga,
      linkedPo ? `${linkedPo.tujuanSppg} (${formatDate(linkedPo.tanggalPo)})` : '',
      it.catatan || '', it.createdBy || '',
    ];
  });

  let total = 0;
  items.forEach(it => { total += typeof it.harga === 'number' ? it.harga : 0; });
  rows.push([]);
  rows.push(['TOTAL PENGELUARAN', '', '', '', '', '', '', '', total]);

  downloadCsv(`Laporan-Pembelian-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initPembelianEvents() {
  document.getElementById('btnSavePembelian').addEventListener('click', savePembelian);
  document.getElementById('btnTambahBarangPembelian').addEventListener('click', () => addItemRow());
  document.getElementById('pembelianFilterDari').addEventListener('change', renderPembelian);
  document.getElementById('pembelianFilterSampai').addEventListener('change', renderPembelian);
  document.getElementById('btnPembelianFilterReset').addEventListener('click', () => {
    document.getElementById('pembelianFilterDari').value = '';
    document.getElementById('pembelianFilterSampai').value = '';
    renderPembelian();
  });
  document.getElementById('btnDownloadPembelian').addEventListener('click', downloadLaporanPembelian);
  document.getElementById('btnCancelEditPembelian').addEventListener('click', cancelEditPembelian);
  document.getElementById('pembelianPoId').addEventListener('change', refreshAllRowPoItemSelects);
  resetItemRows();
  refreshPoOptions();
}
