// ---------- Invoice pengiriman Air ARSI — satu invoice per satu catatan pengiriman ----------
// Mirip Invoice PO di Koperasi (js/ui-po-sppg.js), tapi nomornya sengaja pakai deret TERPISAH
// (prefix "INV-ARSI/", bukan "INV/") supaya tidak numpuk/tertukar dengan nomor Invoice Koperasi,
// yang sudah disamakan manual ke urutan asli milik Koperasi.
import { doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { YAYASAN_INFO } from './data.js';
import { formatRupiah, formatDate, todayIso, escapeHtml } from './utils.js';
import { logActivity } from './activity-log.js';
import { printReport, simpanSebagaiGambar } from './print-report.js';

const TTD_URL = 'assets/invoice/ttd-koperasi.png';

/** "Dapur Nambo" -> "Dapur_Nambo" — dipakai untuk nama file unduhan. */
function slugifyTujuan(tujuan) {
  return (tujuan || 'Pelanggan').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
}

/** "2026-09-10" -> "10Sep2026" — dipakai untuk nama file unduhan. */
function fileDateTag(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d}${bulan[parseInt(m, 10) - 1]}${y}`;
}

function nextInvoiceNomorRsi(year) {
  const prefix = `INV-ARSI/${year}/`;
  let max = 0;
  state.lastDistItems.forEach(it => {
    if (it.invoiceNomor && it.invoiceNomor.startsWith(prefix)) {
      const n = parseInt(it.invoiceNomor.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function invoiceBodyHtml(it) {
  const tglKirim = it.tanggalKirim || it.tanggal;
  const bayarBlok = it.dibayar
    ? `<div class="invoice-pay-box"><div class="title" style="color:#2F8F4E;">✓ Sudah Dibayar${it.metodeBayar ? ' · ' + escapeHtml(it.metodeBayar) : ''}</div></div>`
    : `<div class="invoice-pay-box">
        <div class="title">Mohon dibayarkan ke rekening berikut:</div>
        <div class="pay-row"><span>Name of Bank</span><span>: <b>${escapeHtml(YAYASAN_INFO.bankNama)}</b></span></div>
        <div class="pay-row"><span>Account No.</span><span>: ${escapeHtml(YAYASAN_INFO.bankRekening)}</span></div>
        <div class="pay-row"><span></span><span>: ${escapeHtml(YAYASAN_INFO.bankAtasNama)}</span></div>
      </div>`;

  return `
    <div class="doc-accent-arsi">
      <div class="invoice-head">
        <div class="invoice-head-company">
          <div>
            <b>${escapeHtml(YAYASAN_INFO.nama.toUpperCase())}</b>
            ${YAYASAN_INFO.alamatBaris.map(line => `<div class="addr">${escapeHtml(line)}</div>`).join('')}
          </div>
        </div>
        <div class="invoice-title">INVOICE</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">To: <b>${escapeHtml(it.tujuan)}</b></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Tanggal:</span> ${formatDate(it.invoiceTanggal)}</div>
          <div class="row"><span class="lbl">Nomor:</span> ${escapeHtml(it.invoiceNomor)}</div>
        </div>
      </div>
      <table class="invoice-table">
        <thead><tr><th>No</th><th>Tanggal Kirim</th><th>Produk</th><th>Qty</th><th>Satuan</th><th>Harga Satuan</th><th>Nominal</th></tr></thead>
        <tbody>
          <tr>
            <td>1</td>
            <td>${formatDate(tglKirim)}</td>
            <td>${escapeHtml(it.produkNama || '')}</td>
            <td>${it.jumlah ?? '-'}</td>
            <td>${escapeHtml(it.satuan || '')}</td>
            <td style="text-align:right">${typeof it.hargaSatuan === 'number' ? formatRupiah(it.hargaSatuan).replace('Rp ', '') : '-'}</td>
            <td style="text-align:right">${typeof it.total === 'number' ? formatRupiah(it.total).replace('Rp ', '') : '-'}</td>
          </tr>
        </tbody>
      </table>
      ${it.keterangan ? `<div style="margin-top:8px;font-size:11.5px;"><b>Keterangan:</b> ${escapeHtml(it.keterangan)}</div>` : ''}
      <div class="invoice-bottom-row">
        ${bayarBlok}
        <div class="invoice-total-box">
          <div class="row total"><span>Total</span><span>${formatRupiah(it.total || 0)}</span></div>
        </div>
      </div>
      <div class="invoice-signature">
        <div>Hormat kami,<br>${escapeHtml(YAYASAN_INFO.namaSingkat)}</div>
        <div class="sig-visual">
          <img class="sig-ttd sig-ttd-solo" src="${TTD_URL}" alt="">
        </div>
        <div class="sig-name">${escapeHtml(YAYASAN_INFO.penandaTangan)}</div>
      </div>
      <div class="invoice-bottom-rule"></div>
    </div>
  `;
}

/**
 * Cetak/simpan Invoice untuk satu catatan pengiriman. Nomor invoice diambil dari prompt (bisa diedit
 * manual, prefill saran otomatis) — sama seperti pola di Invoice Koperasi (js/ui-po-sppg.js).
 * @param {string} id - id dokumen pengiriman
 * @param {'print'|'gambar'} [mode]
 */
export async function cetakInvoicePengiriman(id, mode) {
  const it = state.lastDistItems.find(x => x.id === id);
  if (!it) return;
  const tanggalInvoice = it.invoiceTanggal || it.tanggalKirim || it.tanggal || todayIso();
  const saran = it.invoiceNomor || nextInvoiceNomorRsi(tanggalInvoice.slice(0, 4));

  const isian = prompt('Nomor Invoice (boleh diubah manual, kosongkan untuk memakai saran):', saran);
  if (isian === null) return; // batal
  const nomor = isian.trim() || saran;

  const dipakaiLain = state.lastDistItems.find(x => x.id !== id && x.invoiceNomor === nomor);
  if (dipakaiLain && !confirm(`Nomor invoice "${nomor}" sudah dipakai catatan pengiriman ke ${dipakaiLain.tujuan}. Tetap pakai nomor ini juga?`)) {
    return;
  }

  try {
    await updateDoc(doc(state.db, 'pengiriman', id), {
      invoiceNomor: nomor, invoiceTanggal: tanggalInvoice,
      updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    if (!it.invoiceNomor) {
      logActivity({ action: 'ubah', modul: 'Distribusi', ringkasan: `Cetak Invoice ${nomor} untuk pengiriman ke ${it.tujuan}` });
    } else if (it.invoiceNomor !== nomor) {
      logActivity({ action: 'ubah', modul: 'Distribusi', ringkasan: `Ubah nomor Invoice pengiriman ke ${it.tujuan} dari ${it.invoiceNomor} jadi ${nomor}` });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan nomor invoice. Cetak dibatalkan.');
    return;
  }

  const body = invoiceBodyHtml({ ...it, invoiceNomor: nomor, invoiceTanggal: tanggalInvoice });
  const filename = `Invoice-${slugifyTujuan(it.tujuan)}-${fileDateTag(tanggalInvoice)}`;
  if (mode === 'gambar') simpanSebagaiGambar(body, filename);
  else printReport(body, filename);
}
