// ---------- Air ARSI — Bersedekah (pengiriman gratis/donasi, bukan transaksi jual-beli) ----------
// Bentuknya sama seperti Distribusi & Pengiriman (produk, jumlah, tujuan, tanggal kirim), tapi TANPA
// status pembayaran -- barang ini disumbangkan, tidak ditagih. "Nilai Estimasi" cuma referensi
// (dihitung dari harga katalog saat itu, untuk laporan dampak/CSR), BUKAN piutang atau pemasukan --
// sengaja tidak ikut dihitung di Rekap Keuangan sama sekali.
import { collection, addDoc, doc, updateDoc, deleteDoc, query, orderBy, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { PRODUK, produkLabel, produkById, priceFor } from './data.js';
import { formatRupiah, formatDate, escapeHtml } from './utils.js';
import { ensureLokasiTersimpan } from './ui-lokasi.js';
import { logActivity } from './activity-log.js';

let editingId = null;

export function initSedekahProdukSelect() {
  const opts = PRODUK.map(p => `<option value="${p.id}">${produkLabel(p)}</option>`).join('');
  const sel = document.getElementById('sedekahProduk');
  sel.innerHTML = opts;

  const filterSel = document.getElementById('sedekahFilterProduk');
  filterSel.innerHTML = `<option value="all">Semua Produk</option>` + opts;
  filterSel.addEventListener('change', renderSedekahLog);

  sel.addEventListener('change', updateSedekahUI);
  document.getElementById('sedekahJumlah').addEventListener('input', updateSedekahEstimasi);
  document.getElementById('btnCancelEditSedekah').addEventListener('click', cancelEditSedekah);

  updateSedekahUI();
}

export function updateSedekahUI() {
  const produk = produkById(document.getElementById('sedekahProduk').value);
  document.getElementById('sedekahSatuan').textContent = produk ? produk.satuan : '';
  updateSedekahEstimasi();
}

function updateSedekahEstimasi() {
  const produk = produkById(document.getElementById('sedekahProduk').value);
  const jumlah = Number(document.getElementById('sedekahJumlah').value) || 0;
  const harga = produk ? priceFor(produk, produk.priceType === 'tier' ? produk.tiers[0].label : null) : 0;
  const total = harga * jumlah;
  document.getElementById('sedekahEstimasi').textContent = jumlah > 0 ? formatRupiah(total) : '—';
}

function sedekahItemHtml(it) {
  return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.tujuan)}</b>
        <div class="meta">${escapeHtml(it.produkNama)}${it.keterangan ? ' · ' + escapeHtml(it.keterangan) : ''}</div>
        <div class="meta">Kirim: ${formatDate(it.tanggalKirim)}</div>
        ${it.createdBy ? `<div class="meta">Diinput oleh ${escapeHtml(it.createdBy)}</div>` : ''}
      </div>
      <div class="right">
        <div class="qty">${it.jumlah} ${escapeHtml(it.satuan)}</div>
        ${typeof it.nilaiEstimasi === 'number' ? `<div class="dist-item-total">Estimasi: ${formatRupiah(it.nilaiEstimasi)}</div>` : ''}
        <div class="dist-item-actions">
          <span class="pay-badge lunas">🤲 Sedekah</span>
          <button class="edit-btn" data-editid="${it.id}" title="Edit catatan ini">✏️</button>
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>`;
}

export function renderSedekahLog() {
  const logEl = document.getElementById('sedekahLog');
  const filter = document.getElementById('sedekahFilterProduk').value;
  const items = filter === 'all' ? state.lastSedekahItems : state.lastSedekahItems.filter(it => it.produkId === filter);

  const totalJumlah = items.length;
  const totalEstimasi = items.reduce((s, it) => s + (typeof it.nilaiEstimasi === 'number' ? it.nilaiEstimasi : 0), 0);
  const countEl = document.getElementById('sedekahTotalCatatan');
  const estEl = document.getElementById('sedekahTotalEstimasi');
  if (countEl) countEl.textContent = String(totalJumlah);
  if (estEl) estEl.textContent = formatRupiah(totalEstimasi);

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada catatan sedekah untuk filter ini.</div>`;
    return;
  }
  logEl.innerHTML = items.map(sedekahItemHtml).join('');

  logEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteSedekah(btn.dataset.delid));
  });
  logEl.querySelectorAll('button.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = state.lastSedekahItems.find(it => it.id === btn.dataset.editid);
      if (item) startEditSedekah(item);
    });
  });
}

export function watchSedekah(onChange) {
  const logEl = document.getElementById('sedekahLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data sedekah...</div>`;
  const q = query(collection(state.db, 'sedekah'), orderBy('createdAt', 'desc'), limit(200));
  if (state.sedekahUnsub) state.sedekahUnsub();
  state.sedekahUnsub = onSnapshot(q, (qs) => {
    state.lastSedekahItems = [];
    qs.forEach(d => state.lastSedekahItems.push({ id: d.id, ...d.data() }));
    if (state.lastSedekahItems.length === 0) {
      logEl.innerHTML = `<div class="empty-state">Belum ada catatan sedekah. Tambahkan yang pertama di sebelah kiri.</div>`;
      renderSedekahLog(); // tetap panggil supaya kartu total ter-reset ke 0
    } else {
      renderSedekahLog();
    }
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data sedekah.</div>`;
  });
}

function startEditSedekah(item) {
  editingId = item.id;
  document.getElementById('sedekahTanggalKirim').value = item.tanggalKirim || '';
  document.getElementById('sedekahTujuan').value = item.tujuan || '';
  document.getElementById('sedekahProduk').value = item.produkId || '';
  updateSedekahUI();
  document.getElementById('sedekahJumlah').value = item.jumlah ?? '';
  document.getElementById('sedekahKeterangan').value = item.keterangan || '';
  updateSedekahEstimasi();

  document.getElementById('btnSaveSedekah').textContent = 'Update Sedekah';
  document.getElementById('btnCancelEditSedekah').classList.remove('hidden');
  document.getElementById('sedekahTujuan').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditSedekah() {
  editingId = null;
  document.getElementById('sedekahTujuan').value = '';
  document.getElementById('sedekahJumlah').value = '';
  document.getElementById('sedekahKeterangan').value = '';
  updateSedekahEstimasi();
  document.getElementById('btnSaveSedekah').textContent = 'Simpan Sedekah';
  document.getElementById('btnCancelEditSedekah').classList.add('hidden');
}

async function deleteSedekah(id) {
  if (!id) return;
  if (!confirm('Hapus catatan sedekah ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const item = state.lastSedekahItems.find(it => it.id === id);
  try {
    await deleteDoc(doc(state.db, 'sedekah', id));
    if (item) {
      logActivity({
        action: 'hapus', modul: 'Air ARSI - Bersedekah',
        ringkasan: `Hapus sedekah ${item.jumlah} ${item.satuan || ''} (${item.produkNama || ''}) ke ${item.tujuan}`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function saveSedekah() {
  const tanggalKirim = document.getElementById('sedekahTanggalKirim').value;
  const tujuan = document.getElementById('sedekahTujuan').value.trim();
  const produkId = document.getElementById('sedekahProduk').value;
  const jumlah = document.getElementById('sedekahJumlah').value;
  const keterangan = document.getElementById('sedekahKeterangan').value.trim();
  const produk = produkById(produkId);

  if (!tanggalKirim || !tujuan || !jumlah || !produk) {
    alert('Mohon isi tanggal kirim, tujuan/penerima, produk, dan jumlah.');
    return;
  }
  const hargaSatuan = priceFor(produk, produk.priceType === 'tier' ? produk.tiers[0].label : null);
  const nilaiEstimasi = hargaSatuan * Number(jumlah);
  const isEdit = !!editingId;

  const entry = {
    tanggalKirim,
    tujuan,
    produkId: produk.id,
    produkNama: produkLabel(produk),
    satuan: produk.satuan,
    jumlah: Number(jumlah),
    nilaiEstimasi,
    keterangan,
  };
  if (isEdit) {
    entry.updatedAt = Date.now();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.createdAt = Date.now();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSaveSedekah');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'sedekah', editingId), entry);
      logActivity({
        action: 'ubah', modul: 'Air ARSI - Bersedekah',
        ringkasan: `Update sedekah ${entry.jumlah} ${entry.satuan} (${entry.produkNama}) ke ${tujuan}`,
      });
      cancelEditSedekah();
    } else {
      await addDoc(collection(state.db, 'sedekah'), entry);
      logActivity({
        action: 'tambah', modul: 'Air ARSI - Bersedekah',
        ringkasan: `Sedekah ${entry.jumlah} ${entry.satuan} (${entry.produkNama}) ke ${tujuan}`,
      });
      await ensureLokasiTersimpan(tujuan);
      document.getElementById('sedekahTujuan').value = '';
      document.getElementById('sedekahJumlah').value = '';
      document.getElementById('sedekahKeterangan').value = '';
      updateSedekahEstimasi();
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan data sedekah. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update Sedekah' : 'Simpan Sedekah';
  }
}

export function initSedekahEvents() {
  document.getElementById('btnSaveSedekah').addEventListener('click', saveSedekah);
}
