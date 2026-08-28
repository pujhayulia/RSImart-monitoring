// ---------- Koperasi Bahan Makanan — Biaya Operasional (di luar pembelian barang) ----------
// Satu catatan biaya = satu dokumen di collection "biayaOperasional". Dipakai sebagai
// pengurang "Total Profit Real" di Laporan Keuangan Koperasi (lihat ui-laporan-keuangan-koperasi.js),
// meniru pola "GRAND TOTAL PEMBELIAN + OPP" pada LPJ Pengadaan Bahan Baku milik koperasi.
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

const KATEGORI_LABEL = { koperasi: 'Operasional Koperasi', dapur: 'Operasional Dapur' };

let editingId = null;

export function watchBiayaOperasional(onChange) {
  const logEl = document.getElementById('biayaOpLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data biaya operasional...</div>`;
  const q = query(collection(state.db, 'biayaOperasional'), orderBy('createdAt', 'desc'), limit(500));
  if (state.biayaOperasionalUnsub) state.biayaOperasionalUnsub();
  state.biayaOperasionalUnsub = onSnapshot(q, (qs) => {
    state.lastBiayaOperasionalItems = [];
    qs.forEach(d => state.lastBiayaOperasionalItems.push({ id: d.id, ...d.data() }));
    renderBiayaOperasional();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data biaya operasional.</div>`;
  });
}

/** Biaya operasional yang tanggalnya masuk rentang dari/sampai (boleh kosong = tak terbatas). Diekspor untuk Laporan Keuangan Koperasi. */
export function biayaOperasionalInRange(dari, sampai) {
  if (!dari && !sampai) return state.lastBiayaOperasionalItems;
  return state.lastBiayaOperasionalItems.filter(it => isDateStrInRange(it.tanggal, dari, sampai));
}

function filteredBiayaOperasional() {
  const dari = document.getElementById('biayaOpFilterDari').value;
  const sampai = document.getElementById('biayaOpFilterSampai').value;
  return biayaOperasionalInRange(dari, sampai);
}

export function renderBiayaOperasional() {
  const logEl = document.getElementById('biayaOpLog');
  const items = filteredBiayaOperasional();

  let total = 0;
  items.forEach(it => { total += typeof it.jumlah === 'number' ? it.jumlah : 0; });
  const totalEl = document.getElementById('biayaOpTotal');
  const totalTransaksiEl = document.getElementById('biayaOpTotalTransaksi');
  if (totalEl) totalEl.textContent = formatRupiah(total);
  if (totalTransaksiEl) totalTransaksiEl.textContent = String(items.length);

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada catatan biaya operasional untuk rentang tanggal ini.</div>`;
    return;
  }

  logEl.innerHTML = items.map(it => `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.keterangan)}</b>
        <div class="meta">${escapeHtml(it.lokasi || '-')} · ${KATEGORI_LABEL[it.kategori] || it.kategori}</div>
        <div class="meta">Tanggal: ${formatDate(it.tanggal)} · Dicatat ${formatTimestamp(it.createdAt)}</div>
        ${it.createdBy ? `<div class="meta">Diinput oleh ${escapeHtml(it.createdBy)}</div>` : ''}
      </div>
      <div class="right">
        <div class="dist-item-total">${formatRupiah(it.jumlah)}</div>
        <div class="dist-item-actions">
          <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>
  `).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteBiayaOperasional(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastBiayaOperasionalItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditBiayaOperasional(item);
    });
  });
}

function startEditBiayaOperasional(item) {
  editingId = item.id;
  document.getElementById('biayaOpTanggal').value = item.tanggal || '';
  document.getElementById('biayaOpLokasi').value = item.lokasi || '';
  document.getElementById('biayaOpKategori').value = item.kategori || 'koperasi';
  document.getElementById('biayaOpKeterangan').value = item.keterangan || '';
  document.getElementById('biayaOpJumlah').value = item.jumlah ?? '';

  document.getElementById('btnSaveBiayaOp').textContent = 'Update Biaya';
  document.getElementById('btnCancelEditBiayaOp').classList.remove('hidden');
  document.getElementById('biayaOpLokasi').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditBiayaOperasional() {
  editingId = null;
  document.getElementById('biayaOpLokasi').value = '';
  document.getElementById('biayaOpKategori').value = 'koperasi';
  document.getElementById('biayaOpKeterangan').value = '';
  document.getElementById('biayaOpJumlah').value = '';
  document.getElementById('btnSaveBiayaOp').textContent = 'Simpan Biaya';
  document.getElementById('btnCancelEditBiayaOp').classList.add('hidden');
}

async function deleteBiayaOperasional(id) {
  if (!id) return;
  if (!confirm('Hapus catatan biaya operasional ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastBiayaOperasionalItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'biayaOperasional', id));
    if (item) {
      logActivity({
        action: 'hapus',
        modul: 'Koperasi - Biaya Operasional',
        ringkasan: `Hapus biaya operasional ${item.keterangan} (${formatRupiah(item.jumlah)})`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveBiayaOperasional() {
  const tanggal = document.getElementById('biayaOpTanggal').value;
  const lokasi = document.getElementById('biayaOpLokasi').value.trim();
  const kategori = document.getElementById('biayaOpKategori').value;
  const keterangan = document.getElementById('biayaOpKeterangan').value.trim();
  const jumlah = document.getElementById('biayaOpJumlah').value;

  if (!tanggal || !keterangan || jumlah === '') {
    alert('Mohon isi tanggal, keterangan, dan jumlah.');
    return;
  }

  const entry = { tanggal, lokasi, kategori, keterangan, jumlah: Number(jumlah) };
  const isEdit = !!editingId;
  if (isEdit) {
    entry.updatedAt = serverTimestamp();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.createdAt = serverTimestamp();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSaveBiayaOp');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'biayaOperasional', editingId), entry);
      logActivity({
        action: 'ubah',
        modul: 'Koperasi - Biaya Operasional',
        ringkasan: `Update biaya operasional ${entry.keterangan} (${formatRupiah(entry.jumlah)})`,
      });
      cancelEditBiayaOperasional();
    } else {
      await addDoc(collection(state.db, 'biayaOperasional'), entry);
      logActivity({
        action: 'tambah',
        modul: 'Koperasi - Biaya Operasional',
        ringkasan: `Catat biaya operasional ${entry.keterangan} (${formatRupiah(entry.jumlah)})`,
      });
      document.getElementById('biayaOpLokasi').value = '';
      document.getElementById('biayaOpKeterangan').value = '';
      document.getElementById('biayaOpJumlah').value = '';
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan biaya operasional. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Biaya' : 'Simpan Biaya';
  }
}

export function downloadLaporanBiayaOperasional() {
  const dari = document.getElementById('biayaOpFilterDari').value;
  const sampai = document.getElementById('biayaOpFilterSampai').value;
  const items = filteredBiayaOperasional();

  if (items.length === 0) {
    alert('Tidak ada data biaya operasional untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal', 'Lokasi/Dapur', 'Kategori', 'Keterangan', 'Jumlah (Rp)', 'Diinput Oleh', 'Dicatat Pada'];
  const rows = items.map(it => [
    formatDate(it.tanggal), it.lokasi || '', KATEGORI_LABEL[it.kategori] || it.kategori,
    it.keterangan, it.jumlah, it.createdBy || '', formatTimestamp(it.createdAt),
  ]);

  let total = 0;
  items.forEach(it => { total += typeof it.jumlah === 'number' ? it.jumlah : 0; });
  rows.push([]);
  rows.push(['TOTAL BIAYA OPERASIONAL', '', '', '', total]);

  downloadCsv(`Laporan-Biaya-Operasional-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initBiayaOperasionalEvents() {
  document.getElementById('btnSaveBiayaOp').addEventListener('click', saveBiayaOperasional);
  document.getElementById('biayaOpFilterDari').addEventListener('change', renderBiayaOperasional);
  document.getElementById('biayaOpFilterSampai').addEventListener('change', renderBiayaOperasional);
  document.getElementById('btnBiayaOpFilterReset').addEventListener('click', () => {
    document.getElementById('biayaOpFilterDari').value = '';
    document.getElementById('biayaOpFilterSampai').value = '';
    renderBiayaOperasional();
  });
  document.getElementById('btnDownloadBiayaOp').addEventListener('click', downloadLaporanBiayaOperasional);
  document.getElementById('btnCancelEditBiayaOp').addEventListener('click', cancelEditBiayaOperasional);
}
