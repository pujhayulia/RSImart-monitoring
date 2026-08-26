// ---------- Komponen bersama: baris item pengiriman ----------
// Dipakai oleh log Distribusi maupun Daftar Piutang di Keuangan, supaya
// markup dan aksi (tandai lunas / hapus) tidak dobel dua kali.
import { doc, deleteDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { produkById, produkLabel, PRODUK } from './data.js';
import { formatDate, formatRupiah, escapeHtml } from './utils.js';

export async function deletePengiriman(id) {
  if (!id) return;
  if (!confirm('Hapus catatan pengiriman ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await deleteDoc(doc(state.db, 'pengiriman', id));
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

export async function markLunas(id, btnEl, metodeBayar) {
  if (!id) return;
  btnEl.disabled = true; btnEl.textContent = 'Menyimpan...';
  try {
    await updateDoc(doc(state.db, 'pengiriman', id), { dibayar: true, metodeBayar: metodeBayar || 'Tunai' });
  } catch (e) {
    console.error(e);
    alert('Gagal menandai lunas.');
    btnEl.disabled = false; btnEl.textContent = 'Tandai Lunas';
  }
}

const METODE_OPTIONS = ['Tunai', 'Transfer', 'QRIS']
  .map(m => `<option value="${m}">${m}</option>`).join('');

/**
 * @param {object} it - dokumen pengiriman
 * @param {{showProdukMeta?: boolean}} opts - showProdukMeta juga menampilkan nama produk/tanggal pesan (log distribusi)
 */
export function renderDistItemHtml(it, opts = {}) {
  const produk = produkById(it.produkId) || PRODUK[0];
  const namaProduk = it.produkNama || produkLabel(produk);
  const satuan = it.satuan || produk.satuan;
  const tglKirim = it.tanggalKirim || it.tanggal;
  const lunas = !!it.dibayar;

  const meta = opts.showProdukMeta
    ? `<div class="meta">${escapeHtml(namaProduk)}${it.tipeHarga ? ' · ' + escapeHtml(it.tipeHarga) : ''}${it.keterangan ? ' · ' + escapeHtml(it.keterangan) : ''}</div>
       <div class="meta">Pesan: ${formatDate(it.tanggalPesan || it.tanggal)} → Kirim: ${formatDate(tglKirim)}</div>`
    : `<div class="meta">${escapeHtml(namaProduk)} · Kirim: ${formatDate(tglKirim)}</div>`;

  const amount = opts.showProdukMeta
    ? `<div class="qty">${it.jumlah} ${escapeHtml(satuan)}</div>
       ${typeof it.total === 'number' ? `<div class="dist-item-total">${formatRupiah(it.total)}</div>` : ''}`
    : `<div class="qty">${formatRupiah(it.total)}</div>`;

  const payAction = lunas
    ? `<span class="pay-badge lunas">Lunas${it.metodeBayar ? ' · ' + escapeHtml(it.metodeBayar) : ''}</span>`
    : `<select class="metode-mini" data-metodefor="${it.id}" aria-label="Metode pembayaran">${METODE_OPTIONS}</select>
       <button class="pay-badge belum" data-id="${it.id}">Tandai Lunas</button>`;

  return `
    <div class="dist-item">
      <div class="left">
        <b>${escapeHtml(it.tujuan)}</b>
        ${meta}
      </div>
      <div class="right">
        ${amount}
        <div class="dist-item-actions">
          ${payAction}
          <button class="del-btn" data-delid="${it.id}" title="Hapus catatan ini">🗑</button>
        </div>
      </div>
    </div>
  `;
}

/** Pasang event listener tombol "Tandai Lunas" & "Hapus" pada sebuah container yang sudah diisi renderDistItemHtml(). */
export function wireDistItemActions(containerEl) {
  containerEl.querySelectorAll('button.pay-badge.belum').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = containerEl.querySelector(`select.metode-mini[data-metodefor="${btn.dataset.id}"]`);
      markLunas(btn.dataset.id, btn, sel ? sel.value : 'Tunai');
    });
  });
  containerEl.querySelectorAll('button.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deletePengiriman(btn.dataset.delid));
  });
}
