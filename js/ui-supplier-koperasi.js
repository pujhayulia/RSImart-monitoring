// ---------- Koperasi Bahan Makanan — Data Supplier ----------
// Daftar toko/supplier yang biasa jadi sumber belanja koperasi, dengan kontak & area pengantaran.
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, onSnapshot, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv } from './csv-export.js';
import { SUPPLIER_ARSIP_DATA } from './supplier-arsip-data.js';

const ARSIP_BATCH = 'data-supplier-arsip-klien-2026-10';

const FIELD_IDS = ['Komoditas', 'NamaToko', 'NamaPemilik', 'Telp', 'Jenis', 'Alamat', 'Pengantaran', 'Area', 'Kode', 'Catatan'];

let editingId = null;

function fieldEl(name) {
  return document.getElementById('sup' + name);
}

export function watchSupplier(onChange) {
  const logEl = document.getElementById('supLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data supplier...</div>`;
  const q = query(collection(state.db, 'supplierKoperasi'), orderBy('namaTokoUsaha'));
  if (state.supplierUnsub) state.supplierUnsub();
  state.supplierUnsub = onSnapshot(q, (qs) => {
    state.lastSupplierItems = [];
    qs.forEach(d => state.lastSupplierItems.push({ id: d.id, ...d.data() }));
    renderSupplier();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data supplier.</div>`;
  });
}

function filteredSupplier() {
  const q = document.getElementById('supFilterCari').value.trim().toLowerCase();
  if (!q) return state.lastSupplierItems;
  return state.lastSupplierItems.filter(it =>
    (it.namaTokoUsaha || '').toLowerCase().includes(q) ||
    (it.komoditasBahan || '').toLowerCase().includes(q) ||
    (it.supplierDapur || '').toLowerCase().includes(q)
  );
}

export function renderSupplier() {
  const logEl = document.getElementById('supLog');
  const items = filteredSupplier();

  const countEl = document.getElementById('supTotal');
  if (countEl) countEl.textContent = String(state.lastSupplierItems.length);

  const importBar = document.getElementById('supImportBar');
  if (importBar) importBar.classList.toggle('hidden', !arsipSupplierBelumDiimpor());

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada supplier untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = items.map(it => `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.namaTokoUsaha)}</b>
        <div class="meta">${escapeHtml(it.komoditasBahan || '-')} · ${escapeHtml(it.jenisSupplier || '-')}</div>
        ${it.namaPemilik ? `<div class="meta">Pemilik: ${escapeHtml(it.namaPemilik)}${it.telp ? ' · ' + escapeHtml(it.telp) : ''}</div>` : ''}
        ${it.alamat ? `<div class="meta">${escapeHtml(it.alamat)}</div>` : ''}
        ${it.catatan ? `<div class="meta">Catatan: ${escapeHtml(it.catatan)}</div>` : ''}
      </div>
      <div class="right">
        <div class="meta">${escapeHtml(it.pengantaran || '-')}</div>
        <div class="meta">${escapeHtml(it.supplierDapur || '-')}</div>
        ${it.kodePembelian ? `<div class="meta">Kode: ${escapeHtml(it.kodePembelian)}</div>` : ''}
        <div class="dist-item-actions">
          <button class="edit-btn" data-editid="${it.id}" title="Edit supplier ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus supplier ini">🗑</button>
        </div>
      </div>
    </div>
  `).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteSupplier(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastSupplierItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditSupplier(item);
    });
  });
}

function startEditSupplier(item) {
  editingId = item.id;
  fieldEl('Komoditas').value = item.komoditasBahan || '';
  fieldEl('NamaToko').value = item.namaTokoUsaha || '';
  fieldEl('NamaPemilik').value = item.namaPemilik || '';
  fieldEl('Telp').value = item.telp || '';
  fieldEl('Jenis').value = item.jenisSupplier || 'UMKM';
  fieldEl('Alamat').value = item.alamat || '';
  fieldEl('Pengantaran').value = item.pengantaran || '';
  fieldEl('Area').value = item.supplierDapur || '';
  fieldEl('Kode').value = item.kodePembelian || '';
  fieldEl('Catatan').value = item.catatan || '';

  document.getElementById('btnSaveSup').textContent = 'Update Supplier';
  document.getElementById('btnCancelEditSup').classList.remove('hidden');
  fieldEl('NamaToko').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditSupplier() {
  editingId = null;
  for (const name of FIELD_IDS) fieldEl(name).value = '';
  fieldEl('Jenis').value = 'UMKM';
  document.getElementById('btnSaveSup').textContent = 'Simpan Supplier';
  document.getElementById('btnCancelEditSup').classList.add('hidden');
}

async function deleteSupplier(id) {
  if (!id) return;
  if (!confirm('Hapus supplier ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastSupplierItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'supplierKoperasi', id));
    if (item) logActivity({ action: 'hapus', modul: 'Koperasi - Data Supplier', ringkasan: `Hapus supplier ${item.namaTokoUsaha}` });
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveSupplier() {
  const namaTokoUsaha = fieldEl('NamaToko').value.trim();
  const komoditasBahan = fieldEl('Komoditas').value.trim();
  if (!namaTokoUsaha || !komoditasBahan) {
    alert('Mohon isi nama toko/usaha dan komoditas bahan.');
    return;
  }
  const entry = {
    komoditasBahan,
    namaTokoUsaha,
    namaPemilik: fieldEl('NamaPemilik').value.trim(),
    telp: fieldEl('Telp').value.trim(),
    jenisSupplier: fieldEl('Jenis').value,
    alamat: fieldEl('Alamat').value.trim(),
    pengantaran: fieldEl('Pengantaran').value.trim(),
    supplierDapur: fieldEl('Area').value.trim(),
    kodePembelian: fieldEl('Kode').value.trim(),
    catatan: fieldEl('Catatan').value.trim(),
  };
  const isEdit = !!editingId;
  if (isEdit) { entry.updatedAt = serverTimestamp(); entry.updatedBy = state.currentUserEmail; }
  else { entry.createdAt = serverTimestamp(); entry.createdBy = state.currentUserEmail; }

  const btn = document.getElementById('btnSaveSup');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'supplierKoperasi', editingId), entry);
      logActivity({ action: 'ubah', modul: 'Koperasi - Data Supplier', ringkasan: `Update supplier ${namaTokoUsaha}` });
      cancelEditSupplier();
    } else {
      await addDoc(collection(state.db, 'supplierKoperasi'), entry);
      logActivity({ action: 'tambah', modul: 'Koperasi - Data Supplier', ringkasan: `Tambah supplier ${namaTokoUsaha}` });
      for (const name of FIELD_IDS) fieldEl(name).value = '';
      fieldEl('Jenis').value = 'UMKM';
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Supplier' : 'Simpan Supplier';
  }
}

export function downloadSupplierCsv() {
  const items = filteredSupplier();
  if (items.length === 0) { alert('Tidak ada data untuk filter ini.'); return; }
  const headers = ['Komoditas Bahan', 'Nama Toko/Usaha', 'Nama Pemilik', 'Telp', 'Jenis Supplier', 'Alamat', 'Pengantaran', 'Supplier Dapur', 'Kode Pembelian', 'Catatan'];
  const rows = items.map(it => [
    it.komoditasBahan, it.namaTokoUsaha, it.namaPemilik || '', it.telp || '', it.jenisSupplier || '',
    it.alamat || '', it.pengantaran || '', it.supplierDapur || '', it.kodePembelian || '', it.catatan || '',
  ]);
  downloadCsv('Data-Supplier-Koperasi.csv', headers, rows);
}

/** true kalau arsip klien belum pernah diimpor — dipakai untuk menampilkan/menyembunyikan banner impor. */
export function arsipSupplierBelumDiimpor() {
  return SUPPLIER_ARSIP_DATA.length > 0 && !state.lastSupplierItems.some(it => it.importBatch === ARSIP_BATCH);
}

/** Import awal satu kali dari arsip Excel klien — seluruh 93 baris, datanya bersih/tidak ambigu. */
export async function importArsipSupplier() {
  if (!arsipSupplierBelumDiimpor()) { alert('Arsip ini sudah pernah diimpor sebelumnya.'); return; }
  if (!confirm(`Import ${SUPPLIER_ARSIP_DATA.length} supplier dari arsip Excel klien ke Data Supplier?`)) return;
  const btn = document.getElementById('btnImportArsipSup');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengimpor...'; }
  try {
    const batch = writeBatch(state.db);
    SUPPLIER_ARSIP_DATA.forEach(it => {
      const ref = doc(collection(state.db, 'supplierKoperasi'));
      batch.set(ref, { ...it, importBatch: ARSIP_BATCH, createdAt: serverTimestamp(), createdBy: state.currentUserEmail });
    });
    await batch.commit();
    logActivity({ action: 'tambah', modul: 'Koperasi - Data Supplier', ringkasan: `Import arsip Data Supplier dari klien (${SUPPLIER_ARSIP_DATA.length} supplier)` });
    alert(`${SUPPLIER_ARSIP_DATA.length} supplier berhasil diimpor.`);
  } catch (e) {
    console.error(e);
    alert('Gagal mengimpor arsip. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import Arsip dari Klien'; }
  }
}

export function initSupplierEvents() {
  document.getElementById('btnSaveSup').addEventListener('click', saveSupplier);
  document.getElementById('btnCancelEditSup').addEventListener('click', cancelEditSupplier);
  document.getElementById('supFilterCari').addEventListener('input', renderSupplier);
  document.getElementById('btnSupFilterReset').addEventListener('click', () => {
    document.getElementById('supFilterCari').value = '';
    renderSupplier();
  });
  document.getElementById('btnDownloadSup').addEventListener('click', downloadSupplierCsv);
  document.getElementById('btnImportArsipSup').addEventListener('click', importArsipSupplier);
}
