// ---------- Koperasi Bahan Makanan — Master Barang ----------
// Daftar referensi bahan baku yang biasa dibeli dapur SPPG dari koperasi: harga PO (jual ke dapur),
// harga beli koperasi (dari toko/supplier), dan margin (dihitung langsung dari dua angka itu, tidak
// disimpan — supaya selalu akurat kalau salah satu harga diedit). Dipakai sebagai referensi harga
// otomatis saat mengisi barang di PO dari SPPG & Pembelian Bahan Makanan (lihat cariMasterBarang()).
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, onSnapshot, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv } from './csv-export.js';
import { MASTER_BARANG_ARSIP_DATA } from './master-barang-arsip-data.js';

const ARSIP_BATCH = 'master-barang-arsip-klien-2026-10';

const FIELD_IDS = ['Sumber', 'Nama', 'Satuan', 'HargaPo', 'HargaBeli', 'Sup1Nama', 'Sup1Kontak', 'Sup2Nama', 'Sup2Kontak', 'Ket'];

let editingId = null;

function fieldEl(name) {
  return document.getElementById('mb' + name);
}

export function watchMasterBarang(onChange) {
  const logEl = document.getElementById('mbLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data master barang...</div>`;
  const q = query(collection(state.db, 'masterBarang'), orderBy('namaBarang'));
  if (state.masterBarangUnsub) state.masterBarangUnsub();
  state.masterBarangUnsub = onSnapshot(q, (qs) => {
    state.lastMasterBarangItems = [];
    qs.forEach(d => state.lastMasterBarangItems.push({ id: d.id, ...d.data() }));
    renderMasterBarang();
    refreshMasterBarangDatalist();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data master barang.</div>`;
  });
}

/** Cari satu barang di Master Barang berdasarkan nama persis (case-insensitive) — dipakai PO dari SPPG
 * & Pembelian untuk auto-isi harga saat nama barang yang diketik/dipilih cocok dengan master. */
export function cariMasterBarang(namaBarang) {
  const target = (namaBarang || '').trim().toLowerCase();
  if (!target) return null;
  return state.lastMasterBarangItems.find(it => (it.namaBarang || '').trim().toLowerCase() === target) || null;
}

/** Isi ulang <datalist id="masterBarangList"> (dipakai di form PO & Pembelian) dari daftar master barang. */
export function refreshMasterBarangDatalist() {
  const list = document.getElementById('masterBarangList');
  if (!list) return;
  list.innerHTML = state.lastMasterBarangItems
    .map(it => `<option value="${escapeHtml(it.namaBarang)}">`).join('');
}

function margin(it) {
  return (typeof it.hargaPoDapur === 'number' && typeof it.hargaBeliKoperasi === 'number')
    ? it.hargaPoDapur - it.hargaBeliKoperasi : null;
}

function filteredMasterBarang() {
  const q = document.getElementById('mbFilterCari').value.trim().toLowerCase();
  const sumber = document.getElementById('mbFilterSumber').value;
  return state.lastMasterBarangItems.filter(it => {
    if (sumber !== 'all' && (it.sumberBahanBaku || '') !== sumber) return false;
    if (q && !(it.namaBarang || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

export function renderMasterBarang() {
  const logEl = document.getElementById('mbLog');
  const items = filteredMasterBarang();

  const countEl = document.getElementById('mbTotalBarang');
  if (countEl) countEl.textContent = String(state.lastMasterBarangItems.length);

  const importBar = document.getElementById('mbImportBar');
  if (importBar) importBar.classList.toggle('hidden', !arsipMasterBarangBelumDiimpor());

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada barang di Master Barang untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = items.map(it => {
    const m = margin(it);
    const supplierLines = [
      it.supplier1Nama ? `Supplier 1: ${escapeHtml(it.supplier1Nama)}${it.supplier1Kontak ? ' · ' + escapeHtml(it.supplier1Kontak) : ''}` : '',
      it.supplier2Nama ? `Supplier 2: ${escapeHtml(it.supplier2Nama)}${it.supplier2Kontak ? ' · ' + escapeHtml(it.supplier2Kontak) : ''}` : '',
    ].filter(Boolean);
    return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.namaBarang)}</b>
        <div class="meta">${escapeHtml(it.sumberBahanBaku || '-')} · per ${escapeHtml(it.satuan || '-')}</div>
        ${supplierLines.map(l => `<div class="meta">${l}</div>`).join('')}
        ${it.keterangan ? `<div class="meta">Ket: ${escapeHtml(it.keterangan)}</div>` : ''}
      </div>
      <div class="right">
        <div class="meta">PO: ${formatRupiah(it.hargaPoDapur)}</div>
        <div class="dist-item-total">Beli: ${formatRupiah(it.hargaBeliKoperasi)}</div>
        <div class="meta" style="color:${m === null ? 'inherit' : (m >= 0 ? 'var(--green)' : '#B5432E')};font-weight:700;">
          Margin: ${m === null ? '-' : formatRupiah(m)}
        </div>
        <div class="dist-item-actions">
          <button class="edit-btn" data-editid="${it.id}" title="Edit barang ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus barang ini">🗑</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteMasterBarang(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastMasterBarangItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditMasterBarang(item);
    });
  });
}

function startEditMasterBarang(item) {
  editingId = item.id;
  fieldEl('Sumber').value = item.sumberBahanBaku || '';
  fieldEl('Nama').value = item.namaBarang || '';
  fieldEl('Satuan').value = item.satuan || '';
  fieldEl('HargaPo').value = item.hargaPoDapur ?? '';
  fieldEl('HargaBeli').value = item.hargaBeliKoperasi ?? '';
  fieldEl('Sup1Nama').value = item.supplier1Nama || '';
  fieldEl('Sup1Kontak').value = item.supplier1Kontak || '';
  fieldEl('Sup2Nama').value = item.supplier2Nama || '';
  fieldEl('Sup2Kontak').value = item.supplier2Kontak || '';
  fieldEl('Ket').value = item.keterangan || '';

  document.getElementById('btnSaveMb').textContent = 'Update Barang';
  document.getElementById('btnCancelEditMb').classList.remove('hidden');
  fieldEl('Nama').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditMasterBarang() {
  editingId = null;
  for (const name of FIELD_IDS) fieldEl(name).value = '';
  document.getElementById('btnSaveMb').textContent = 'Simpan Barang';
  document.getElementById('btnCancelEditMb').classList.add('hidden');
}

async function deleteMasterBarang(id) {
  if (!id) return;
  if (!confirm('Hapus barang ini dari Master Barang? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastMasterBarangItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'masterBarang', id));
    if (item) logActivity({ action: 'hapus', modul: 'Koperasi - Master Barang', ringkasan: `Hapus barang ${item.namaBarang}` });
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveMasterBarang() {
  const sumberBahanBaku = fieldEl('Sumber').value;
  const namaBarang = fieldEl('Nama').value.trim();
  const satuan = fieldEl('Satuan').value.trim();
  const hargaPoDapurStr = fieldEl('HargaPo').value;
  const hargaBeliKoperasiStr = fieldEl('HargaBeli').value;

  if (!namaBarang || !satuan) {
    alert('Mohon isi nama barang dan satuan.');
    return;
  }
  const dup = state.lastMasterBarangItems.find(it => it.id !== editingId && (it.namaBarang || '').trim().toLowerCase() === namaBarang.toLowerCase());
  if (dup && !confirm(`"${namaBarang}" sudah ada di Master Barang. Tetap simpan sebagai barang terpisah? (biasanya lebih baik Edit barang yang sudah ada)`)) return;

  const entry = {
    sumberBahanBaku,
    namaBarang,
    satuan,
    hargaPoDapur: hargaPoDapurStr === '' ? null : Number(hargaPoDapurStr),
    hargaBeliKoperasi: hargaBeliKoperasiStr === '' ? null : Number(hargaBeliKoperasiStr),
    supplier1Nama: fieldEl('Sup1Nama').value.trim(),
    supplier1Kontak: fieldEl('Sup1Kontak').value.trim(),
    supplier2Nama: fieldEl('Sup2Nama').value.trim(),
    supplier2Kontak: fieldEl('Sup2Kontak').value.trim(),
    keterangan: fieldEl('Ket').value.trim(),
  };
  const isEdit = !!editingId;
  if (isEdit) { entry.updatedAt = serverTimestamp(); entry.updatedBy = state.currentUserEmail; }
  else { entry.createdAt = serverTimestamp(); entry.createdBy = state.currentUserEmail; }

  const btn = document.getElementById('btnSaveMb');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'masterBarang', editingId), entry);
      logActivity({ action: 'ubah', modul: 'Koperasi - Master Barang', ringkasan: `Update barang ${namaBarang}` });
      cancelEditMasterBarang();
    } else {
      await addDoc(collection(state.db, 'masterBarang'), entry);
      logActivity({ action: 'tambah', modul: 'Koperasi - Master Barang', ringkasan: `Tambah barang ${namaBarang}` });
      for (const name of FIELD_IDS) fieldEl(name).value = '';
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Barang' : 'Simpan Barang';
  }
}

export function downloadMasterBarangCsv() {
  const items = filteredMasterBarang();
  if (items.length === 0) { alert('Tidak ada data untuk filter ini.'); return; }
  const headers = ['Sumber Bahan Baku', 'Nama Barang', 'Satuan', 'Harga PO Dapur', 'Harga Beli Koperasi', 'Margin', 'Supplier 1', 'Kontak 1', 'Supplier 2', 'Kontak 2', 'Keterangan'];
  const rows = items.map(it => [
    it.sumberBahanBaku || '', it.namaBarang, it.satuan, it.hargaPoDapur, it.hargaBeliKoperasi, margin(it),
    it.supplier1Nama || '', it.supplier1Kontak || '', it.supplier2Nama || '', it.supplier2Kontak || '', it.keterangan || '',
  ]);
  downloadCsv('Master-Barang-Koperasi.csv', headers, rows);
}

/** true kalau arsip klien belum pernah diimpor — dipakai untuk menampilkan/menyembunyikan banner impor. */
export function arsipMasterBarangBelumDiimpor() {
  return MASTER_BARANG_ARSIP_DATA.length > 0 && !state.lastMasterBarangItems.some(it => it.importBatch === ARSIP_BATCH);
}

/** Import awal satu kali dari arsip Excel klien (hanya barang yang namanya tidak ambigu — 61 dari 197
 * baris; 44 nama lain punya beberapa baris harga berbeda tanpa kolom tanggal, jadi SENGAJA tidak
 * diimpor otomatis supaya tidak menebak harga mana yang benar — lihat riwayat chat 2026-10-14). */
export async function importArsipMasterBarang() {
  if (!arsipMasterBarangBelumDiimpor()) { alert('Arsip ini sudah pernah diimpor sebelumnya.'); return; }
  if (!confirm(`Import ${MASTER_BARANG_ARSIP_DATA.length} barang dari arsip Excel klien ke Master Barang?`)) return;
  const btn = document.getElementById('btnImportArsipMb');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengimpor...'; }
  try {
    const batch = writeBatch(state.db);
    MASTER_BARANG_ARSIP_DATA.forEach(it => {
      const ref = doc(collection(state.db, 'masterBarang'));
      batch.set(ref, { ...it, importBatch: ARSIP_BATCH, createdAt: serverTimestamp(), createdBy: state.currentUserEmail });
    });
    await batch.commit();
    logActivity({ action: 'tambah', modul: 'Koperasi - Master Barang', ringkasan: `Import arsip Master Barang dari klien (${MASTER_BARANG_ARSIP_DATA.length} barang)` });
    alert(`${MASTER_BARANG_ARSIP_DATA.length} barang berhasil diimpor.`);
  } catch (e) {
    console.error(e);
    alert('Gagal mengimpor arsip. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import Arsip dari Klien'; }
  }
}

export function initMasterBarangEvents() {
  document.getElementById('btnSaveMb').addEventListener('click', saveMasterBarang);
  document.getElementById('btnCancelEditMb').addEventListener('click', cancelEditMasterBarang);
  document.getElementById('mbFilterCari').addEventListener('input', renderMasterBarang);
  document.getElementById('mbFilterSumber').addEventListener('change', renderMasterBarang);
  document.getElementById('btnMbFilterReset').addEventListener('click', () => {
    document.getElementById('mbFilterCari').value = '';
    document.getElementById('mbFilterSumber').value = 'all';
    renderMasterBarang();
  });
  document.getElementById('btnDownloadMb').addEventListener('click', downloadMasterBarangCsv);
  document.getElementById('btnImportArsipMb').addEventListener('click', importArsipMasterBarang);
}
