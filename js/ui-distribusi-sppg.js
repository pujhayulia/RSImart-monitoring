// ---------- Koperasi Bahan Makanan — Sub-bagian 2: Distribusi/penjualan ke SPPG ----------
// Satu NOTA pengiriman = satu dokumen di collection "distribusiSppg", berisi
// array `items` (bisa banyak barang dalam satu nota). Ini berbeda dari modul
// Pembelian, yang tetap satu barang = satu dokumen.
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

let rowCounter = 0;
let editingId = null;

function itemRowHtml(rowId) {
  return `
    <div class="nota-item-row" data-rowid="${rowId}">
      <input class="nir-nama" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga jual (opsional)">
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

/** Total nilai & jumlah barang dari SELURUH nota yang sudah termuat (tanpa filter tanggal) — dipakai di Beranda Koperasi. */
export function computeDistribusiSppgSummary() {
  const items = flattenItems(state.lastDistribusiSppgItems);
  let totalNilai = 0;
  items.forEach(it => { if (typeof it.hargaJual === 'number') totalNilai += it.hargaJual; });
  return { totalNilai, jumlahItem: items.length };
}

function notaTotalNilai(nota) {
  return (nota.items || []).reduce((sum, it) => sum + (typeof it.hargaJual === 'number' ? it.hargaJual : 0), 0);
}

export function renderDistribusiSppg() {
  const logEl = document.getElementById('sppgLog');
  const notaList = filteredNota();
  const items = flattenItems(notaList);

  let totalNilai = 0;
  items.forEach(it => { if (typeof it.hargaJual === 'number') totalNilai += it.hargaJual; });
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
      </div>
      <div class="right">
        ${nilai > 0 ? `<div class="dist-item-total">${formatRupiah(nilai)}</div>` : ''}
        <div class="dist-item-actions">
          <button type="button" class="btn-ghost nota-toggle-btn" data-notaid="${nota.id}">Lihat Detail</button>
          <button class="edit-btn" data-editid="${nota.id}" title="Edit nota ini">✏️</button>
          <button class="del-btn" data-delid="${nota.id}" title="Hapus nota ini">🗑</button>
        </div>
      </div>
    </div>
    <div class="nota-detail hidden" id="notaDetail-${nota.id}">
      ${(nota.items || []).map(it => `
        <div class="nota-detail-row">
          <span class="nota-detail-nama">${escapeHtml(it.namaBarang)}</span>
          <span class="nota-detail-qty">${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
          <span class="nota-detail-harga">${typeof it.hargaJual === 'number' ? formatRupiah(it.hargaJual) : '-'}</span>
        </div>
      `).join('')}
    </div>`;
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
  document.getElementById('sppgTujuan').value = '';
  document.getElementById('sppgCatatan').value = '';
  resetItemRows();
  document.getElementById('btnSaveSppg').textContent = 'Simpan Nota Pengiriman';
  document.getElementById('btnCancelEditSppg').classList.add('hidden');
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
      await addDoc(collection(state.db, 'distribusiSppg'), entry);
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Distribusi SPPG',
        ringkasan: `Nota distribusi ke ${tujuanSppg} (${items.length} jenis barang)`,
      });
      document.getElementById('sppgTujuan').value = '';
      document.getElementById('sppgCatatan').value = '';
      resetItemRows();
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

  const headers = ['Tanggal Kirim', 'Jam Kirim', 'Tujuan SPPG', 'Catatan Nota', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga Jual (Rp)', 'Diinput Oleh', 'Dicatat Pada'];
  const rows = [];
  notaList.forEach(nota => {
    (nota.items || []).forEach(item => {
      rows.push([
        formatDate(nota.tanggalKirim), nota.jamKirim || '', nota.tujuanSppg, nota.catatan || '',
        item.namaBarang, item.jumlah ?? '', item.satuan || '', item.hargaJual ?? '',
        nota.createdBy || '', formatTimestamp(nota.createdAt),
      ]);
    });
  });

  const totalNilai = flattenItems(notaList).reduce((s, it) => s + (typeof it.hargaJual === 'number' ? it.hargaJual : 0), 0);
  rows.push([]);
  rows.push(['TOTAL NILAI DISTRIBUSI', '', '', '', '', '', '', totalNilai]);

  downloadCsv(`Laporan-Distribusi-SPPG-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initDistribusiSppgEvents() {
  document.getElementById('btnSaveSppg').addEventListener('click', saveDistribusiSppg);
  document.getElementById('btnTambahBarangSppg').addEventListener('click', addItemRow);
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
