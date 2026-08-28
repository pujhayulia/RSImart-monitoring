// ---------- Koperasi Bahan Makanan — Sub-bagian 1: Pembelian dari toko/supplier ----------
// Satu barang yang dibeli = satu dokumen di collection "pembelianBahanMakanan",
// terpisah dari modul Stok Gudang RSI ("rekap"/"pengiriman"/"lokasi").
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, formatDate, formatTimestamp, isTimestampInRange, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

const FIELD_IDS = ['NamaToko', 'NoHp', 'AlamatToko', 'NamaPembeli', 'NamaBarang', 'Jumlah', 'Satuan', 'Harga', 'Catatan'];

let editingId = null;

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
  populatePoItemSelect();
}

function populatePoItemSelect() {
  const poSel = document.getElementById('pembelianPoId');
  const itemSel = document.getElementById('pembelianPoItem');
  if (!poSel || !itemSel) return;
  const current = itemSel.value;
  const po = (state.lastPoSppgItems || []).find(p => p.id === poSel.value);
  if (!po) {
    itemSel.innerHTML = '<option value="">—</option>';
    itemSel.disabled = true;
    return;
  }
  itemSel.disabled = false;
  const items = po.items || [];
  itemSel.innerHTML = items.map((it, idx) => {
    const key = poItemKeyLocal(it, idx);
    const jumlahOrder = typeof it.jumlah === 'number' ? it.jumlah : 0;
    const dibeli = jumlahDibeliUntukPoItem(po.id, key, editingId);
    const sisa = jumlahOrder - dibeli;
    const label = `${it.namaBarang} — ${jumlahOrder} ${it.satuan || ''} dipesan${dibeli > 0 ? `, sisa ${sisa}` : ''}`;
    return `<option value="${key}">${escapeHtml(label)}</option>`;
  }).join('');
  if (items.some((it, idx) => poItemKeyLocal(it, idx) === current)) itemSel.value = current;
}

function applyPoItemToForm() {
  const poSel = document.getElementById('pembelianPoId');
  const itemSel = document.getElementById('pembelianPoItem');
  const po = (state.lastPoSppgItems || []).find(p => p.id === poSel.value);
  if (!po) return;
  const idx = (po.items || []).findIndex((it, i) => poItemKeyLocal(it, i) === itemSel.value);
  if (idx === -1) return;
  const it = po.items[idx];
  fieldEl('NamaBarang').value = it.namaBarang || '';
  fieldEl('Satuan').value = it.satuan || '';
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

function filteredPembelian() {
  const dari = document.getElementById('pembelianFilterDari').value;
  const sampai = document.getElementById('pembelianFilterSampai').value;
  if (!dari && !sampai) return state.lastPembelianItems;
  return state.lastPembelianItems.filter(it => isTimestampInRange(it.createdAt, dari, sampai));
}

/** Total belanja & jumlah transaksi dari SELURUH data yang sudah termuat (tanpa filter tanggal) — dipakai di Beranda Koperasi. */
export function computePembelianSummary() {
  let totalBelanja = 0;
  state.lastPembelianItems.forEach(it => { totalBelanja += typeof it.harga === 'number' ? it.harga : 0; });
  return { totalBelanja, jumlahTransaksi: state.lastPembelianItems.length };
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
        <div class="meta">Dibeli oleh ${escapeHtml(it.namaPembeli)} · ${formatTimestamp(it.createdAt)}</div>
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
  fieldEl('NamaBarang').value = item.namaBarang || '';
  fieldEl('Jumlah').value = item.jumlah ?? '';
  fieldEl('Satuan').value = item.satuan || '';
  fieldEl('Harga').value = item.harga ?? '';
  fieldEl('Catatan').value = item.catatan || '';

  document.getElementById('pembelianPoId').value = item.poId || '';
  populatePoItemSelect();
  document.getElementById('pembelianPoItem').value = item.poItemId || '';

  document.getElementById('btnSavePembelian').textContent = 'Update Pembelian';
  document.getElementById('btnCancelEditPembelian').classList.remove('hidden');
  fieldEl('NamaToko').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditPembelian() {
  editingId = null;
  for (const name of FIELD_IDS) fieldEl(name).value = '';
  document.getElementById('pembelianPoId').value = '';
  populatePoItemSelect();
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

  if (!values.NamaToko || !values.AlamatToko || !values.NamaPembeli || !values.NamaBarang || !values.Jumlah || !values.Satuan || !values.Harga) {
    alert('Mohon isi nama toko, alamat toko, nama pembeli, nama barang, jumlah, satuan, dan harga.');
    return;
  }

  const poId = document.getElementById('pembelianPoId').value || null;
  const poItemId = poId ? (document.getElementById('pembelianPoItem').value || null) : null;

  const entry = {
    namaToko: values.NamaToko,
    noHpToko: values.NoHp,
    alamatToko: values.AlamatToko,
    namaPembeli: values.NamaPembeli,
    namaBarang: values.NamaBarang,
    jumlah: Number(values.Jumlah),
    satuan: values.Satuan,
    harga: Number(values.Harga),
    catatan: values.Catatan,
    poId, poItemId,
  };
  const isEdit = !!editingId;
  if (isEdit) {
    entry.updatedAt = serverTimestamp();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.createdAt = serverTimestamp();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSavePembelian');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'pembelianBahanMakanan', editingId), entry);
      logActivity({
        action: 'ubah',
        modul: 'Koperasi - Pembelian',
        ringkasan: `Update pembelian ${entry.jumlah} ${entry.satuan} ${entry.namaBarang} dari ${entry.namaToko} (${formatRupiah(entry.harga)})`,
      });
      cancelEditPembelian();
    } else {
      await addDoc(collection(state.db, 'pembelianBahanMakanan'), entry);
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Pembelian',
        ringkasan: `Beli ${entry.jumlah} ${entry.satuan} ${entry.namaBarang} dari ${entry.namaToko} (${formatRupiah(entry.harga)})`,
      });
      for (const name of FIELD_IDS) fieldEl(name).value = '';
      document.getElementById('pembelianPoId').value = '';
      populatePoItemSelect();
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

  const headers = ['Tanggal & Jam', 'Nama Toko', 'No. HP Toko', 'Alamat Toko', 'Nama Pembeli', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga (Rp)', 'Untuk PO', 'Catatan', 'Diinput Oleh'];
  const rows = items.map(it => {
    const linkedPo = it.poId ? (state.lastPoSppgItems || []).find(p => p.id === it.poId) : null;
    return [
      formatTimestamp(it.createdAt), it.namaToko, it.noHpToko || '', it.alamatToko || '',
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
  document.getElementById('pembelianFilterDari').addEventListener('change', renderPembelian);
  document.getElementById('pembelianFilterSampai').addEventListener('change', renderPembelian);
  document.getElementById('btnPembelianFilterReset').addEventListener('click', () => {
    document.getElementById('pembelianFilterDari').value = '';
    document.getElementById('pembelianFilterSampai').value = '';
    renderPembelian();
  });
  document.getElementById('btnDownloadPembelian').addEventListener('click', downloadLaporanPembelian);
  document.getElementById('btnCancelEditPembelian').addEventListener('click', cancelEditPembelian);
  document.getElementById('pembelianPoId').addEventListener('change', populatePoItemSelect);
  document.getElementById('pembelianPoItem').addEventListener('change', applyPoItemToForm);
  refreshPoOptions();
}
