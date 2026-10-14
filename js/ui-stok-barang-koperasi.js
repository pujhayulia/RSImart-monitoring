// ---------- Koperasi Bahan Makanan — Stok Barang ----------
// Catatan stok per lokasi/dapur koperasi (terpisah dari Stok Gudang RSI yang untuk produk Air ARSI).
// Sengaja TIDAK diisi data arsip apa pun saat dibuat — Pujha akan menentukan sendiri barang mana yang
// mau dicatat stoknya di sini (lihat riwayat chat 2026-10-14).
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatTimestamp, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv } from './csv-export.js';

const FIELD_IDS = ['Lokasi', 'Pic', 'Barang', 'Satuan', 'Isi', 'StokAwal', 'Masuk', 'Keluar'];

let editingId = null;

function fieldEl(name) {
  return document.getElementById('sb' + name);
}

export function watchStokBarang(onChange) {
  const logEl = document.getElementById('sbLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data stok barang...</div>`;
  const q = query(collection(state.db, 'stokBarangKoperasi'), orderBy('createdAt', 'desc'), limit(500));
  if (state.stokBarangUnsub) state.stokBarangUnsub();
  state.stokBarangUnsub = onSnapshot(q, (qs) => {
    state.lastStokBarangItems = [];
    qs.forEach(d => state.lastStokBarangItems.push({ id: d.id, ...d.data() }));
    renderStokBarang();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data stok barang.</div>`;
  });
}

function filteredStokBarang() {
  const q = document.getElementById('sbFilterCari').value.trim().toLowerCase();
  const lokasi = document.getElementById('sbFilterLokasi').value.trim().toLowerCase();
  return state.lastStokBarangItems.filter(it => {
    if (lokasi && (it.lokasi || '').toLowerCase() !== lokasi) return false;
    if (q && !(it.namaBarang || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Isi ulang dropdown filter lokasi dari nilai-nilai lokasi yang pernah dipakai. */
function refreshLokasiFilterOptions() {
  const sel = document.getElementById('sbFilterLokasi');
  if (!sel) return;
  const current = sel.value;
  const seen = new Set();
  state.lastStokBarangItems.forEach(it => { if (it.lokasi) seen.add(it.lokasi); });
  const lokasiList = [...seen].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Semua Lokasi</option>' + lokasiList.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
  if (lokasiList.includes(current)) sel.value = current;
}

export function renderStokBarang() {
  refreshLokasiFilterOptions();
  const logEl = document.getElementById('sbLog');
  const items = filteredStokBarang();

  if (state.lastStokBarangItems.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada data stok barang. Tambahkan catatan pertama di sebelah kiri.</div>`;
    return;
  }
  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Tidak ada catatan stok untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = items.map(it => {
    const stokAkhir = (typeof it.stokAwal === 'number' ? it.stokAwal : 0)
      + (typeof it.masuk === 'number' ? it.masuk : 0)
      - (typeof it.keluar === 'number' ? it.keluar : 0);
    return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.namaBarang)}</b>
        <div class="meta">${escapeHtml(it.lokasi || '-')}${it.pic ? ' · PIC: ' + escapeHtml(it.pic) : ''}${it.isi ? ' · isi ' + escapeHtml(it.isi) : ''}</div>
        <div class="meta">Awal ${it.stokAwal ?? 0} + Masuk ${it.masuk ?? 0} − Keluar ${it.keluar ?? 0} = <b>${stokAkhir} ${escapeHtml(it.satuan || '')}</b></div>
        <div class="meta">Dicatat ${formatTimestamp(it.createdAt)}${it.createdBy ? ' · oleh ' + escapeHtml(it.createdBy) : ''}</div>
      </div>
      <div class="right">
        <div class="dist-item-total">${stokAkhir} ${escapeHtml(it.satuan || '')}</div>
        <div class="dist-item-actions">
          <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteStokBarang(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastStokBarangItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditStokBarang(item);
    });
  });
}

function startEditStokBarang(item) {
  editingId = item.id;
  fieldEl('Lokasi').value = item.lokasi || '';
  fieldEl('Pic').value = item.pic || '';
  fieldEl('Barang').value = item.namaBarang || '';
  fieldEl('Satuan').value = item.satuan || '';
  fieldEl('Isi').value = item.isi || '';
  fieldEl('StokAwal').value = item.stokAwal ?? '';
  fieldEl('Masuk').value = item.masuk ?? '';
  fieldEl('Keluar').value = item.keluar ?? '';

  document.getElementById('btnSaveSb').textContent = 'Update Stok';
  document.getElementById('btnCancelEditSb').classList.remove('hidden');
  fieldEl('Barang').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditStokBarang() {
  editingId = null;
  for (const name of FIELD_IDS) fieldEl(name).value = '';
  document.getElementById('btnSaveSb').textContent = 'Simpan Stok';
  document.getElementById('btnCancelEditSb').classList.add('hidden');
}

async function deleteStokBarang(id) {
  if (!id) return;
  if (!confirm('Hapus catatan stok ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastStokBarangItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'stokBarangKoperasi', id));
    if (item) logActivity({ action: 'hapus', modul: 'Koperasi - Stok Barang', ringkasan: `Hapus catatan stok ${item.namaBarang} (${item.lokasi || '-'})` });
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveStokBarang() {
  const lokasi = fieldEl('Lokasi').value.trim();
  const namaBarang = fieldEl('Barang').value.trim();
  const satuan = fieldEl('Satuan').value.trim();
  if (!lokasi || !namaBarang || !satuan) {
    alert('Mohon isi lokasi, nama barang, dan satuan.');
    return;
  }
  const entry = {
    lokasi,
    pic: fieldEl('Pic').value.trim(),
    namaBarang,
    satuan,
    isi: fieldEl('Isi').value.trim(),
    stokAwal: fieldEl('StokAwal').value === '' ? 0 : Number(fieldEl('StokAwal').value),
    masuk: fieldEl('Masuk').value === '' ? 0 : Number(fieldEl('Masuk').value),
    keluar: fieldEl('Keluar').value === '' ? 0 : Number(fieldEl('Keluar').value),
  };
  const isEdit = !!editingId;
  if (isEdit) { entry.updatedAt = serverTimestamp(); entry.updatedBy = state.currentUserEmail; }
  else { entry.createdAt = serverTimestamp(); entry.createdBy = state.currentUserEmail; }

  const btn = document.getElementById('btnSaveSb');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'stokBarangKoperasi', editingId), entry);
      logActivity({ action: 'ubah', modul: 'Koperasi - Stok Barang', ringkasan: `Update stok ${namaBarang} (${lokasi})` });
      cancelEditStokBarang();
    } else {
      await addDoc(collection(state.db, 'stokBarangKoperasi'), entry);
      logActivity({ action: 'tambah', modul: 'Koperasi - Stok Barang', ringkasan: `Catat stok ${namaBarang} (${lokasi})` });
      for (const name of FIELD_IDS) fieldEl(name).value = '';
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Stok' : 'Simpan Stok';
  }
}

export function downloadStokBarangCsv() {
  const items = filteredStokBarang();
  if (items.length === 0) { alert('Tidak ada data untuk filter ini.'); return; }
  const headers = ['Lokasi', 'PIC', 'Barang', 'Satuan', 'Isi', 'Stok Awal', 'Masuk', 'Keluar', 'Stok Akhir', 'Dicatat Pada', 'Diinput Oleh'];
  const rows = items.map(it => {
    const stokAkhir = (it.stokAwal || 0) + (it.masuk || 0) - (it.keluar || 0);
    return [it.lokasi, it.pic || '', it.namaBarang, it.satuan, it.isi || '', it.stokAwal ?? 0, it.masuk ?? 0, it.keluar ?? 0, stokAkhir, '', it.createdBy || ''];
  });
  downloadCsv('Stok-Barang-Koperasi.csv', headers, rows);
}

export function initStokBarangEvents() {
  document.getElementById('btnSaveSb').addEventListener('click', saveStokBarang);
  document.getElementById('btnCancelEditSb').addEventListener('click', cancelEditStokBarang);
  document.getElementById('sbFilterCari').addEventListener('input', renderStokBarang);
  document.getElementById('sbFilterLokasi').addEventListener('change', renderStokBarang);
  document.getElementById('btnSbFilterReset').addEventListener('click', () => {
    document.getElementById('sbFilterCari').value = '';
    document.getElementById('sbFilterLokasi').value = '';
    renderStokBarang();
  });
  document.getElementById('btnDownloadSb').addEventListener('click', downloadStokBarangCsv);
}
