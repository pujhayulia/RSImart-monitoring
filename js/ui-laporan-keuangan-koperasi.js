// ---------- Laporan Keuangan Koperasi — gabungan Pembelian (pengeluaran) & Distribusi SPPG (pemasukan) ----------
// computeKoperasiKeuangan() adalah SATU-SATUNYA sumber hitungan, dipakai baik oleh
// widget ringkasan di Beranda Koperasi maupun halaman Laporan Keuangan Koperasi ini,
// supaya angkanya selalu konsisten di kedua tempat.
import { state } from './state.js';
import { formatRupiah, formatDate, isDateStrInRange, escapeHtml } from './utils.js';
import { notaInRange, flattenItems, itemNilai, notaTotalNilai } from './ui-distribusi-sppg.js';
import { computeMarginKotor } from './ui-po-sppg.js';
import { biayaOperasionalInRange } from './ui-biaya-operasional.js';
import { pembelianTanggalIso } from './ui-pembelian.js';
import { downloadCsv, dateRangeFileTag, dateRangeLabel } from './csv-export.js';
import { printReport } from './print-report.js';

/** Dipakai bareng buildLedger(): filter berdasarkan tanggal PO yang ditautkan (kalau ada), bukan createdAt — lihat pembelianTanggalIso(). */
function pembelianInRange(dari, sampai) {
  if (!dari && !sampai) return state.lastPembelianItems;
  return state.lastPembelianItems.filter(it => isDateStrInRange(pembelianTanggalIso(it), dari, sampai));
}

export function computeKoperasiKeuangan(dari, sampai) {
  const pembelian = pembelianInRange(dari, sampai);
  const notaList = notaInRange(dari, sampai);
  const sppgItems = flattenItems(notaList);

  let totalPengeluaran = 0;
  pembelian.forEach(it => { totalPengeluaran += typeof it.harga === 'number' ? it.harga : 0; });

  let totalPemasukan = 0;
  sppgItems.forEach(it => { totalPemasukan += itemNilai(it) || 0; });

  const marginKotor = computeMarginKotor(dari, sampai);
  const biayaOp = biayaOperasionalInRange(dari, sampai);
  let totalBiayaOperasional = 0;
  biayaOp.forEach(it => { totalBiayaOperasional += typeof it.jumlah === 'number' ? it.jumlah : 0; });

  return {
    pembelian, notaList, sppgItems,
    totalPengeluaran, totalPemasukan,
    saldo: totalPemasukan - totalPengeluaran,
    marginKotor, biayaOp, totalBiayaOperasional,
    profitReal: marginKotor - totalBiayaOperasional,
  };
}

function buildLedger(data) {
  const ledger = [];
  data.pembelian.forEach(it => {
    const tgl = pembelianTanggalIso(it);
    ledger.push({
      tanggalSort: tgl,
      tanggalDisplay: formatDate(tgl),
      keterangan: `Pembelian - ${it.namaBarang} dari ${it.namaToko}`,
      jenis: 'Pengeluaran',
      jumlah: typeof it.harga === 'number' ? it.harga : 0,
    });
  });
  data.notaList.forEach(nota => {
    ledger.push({
      tanggalSort: nota.tanggalKirim,
      tanggalDisplay: formatDate(nota.tanggalKirim) + (nota.jamKirim ? ', ' + nota.jamKirim : ''),
      keterangan: `Distribusi - Nota ke ${nota.tujuanSppg} (${(nota.items || []).length} jenis barang)`,
      jenis: 'Pemasukan',
      jumlah: notaTotalNilai(nota),
    });
  });
  ledger.sort((a, b) => (a.tanggalSort < b.tanggalSort ? 1 : a.tanggalSort > b.tanggalSort ? -1 : 0));
  return ledger;
}

function buildBreakdownPengeluaran(pembelian) {
  const map = {};
  pembelian.forEach(it => {
    const key = it.namaBarang || 'Lainnya';
    map[key] = (map[key] || 0) + (typeof it.harga === 'number' ? it.harga : 0);
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function buildBreakdownPemasukan(notaList) {
  const map = {};
  notaList.forEach(nota => {
    const key = nota.tujuanSppg || 'Lainnya';
    map[key] = (map[key] || 0) + notaTotalNilai(nota);
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function finRowsHtml(rows) {
  return rows.length === 0
    ? `<div class="empty-state">Belum ada data.</div>`
    : rows.map(([nama, total]) => `
      <div class="fin-row fin-row--2col">
        <div class="fin-name">${escapeHtml(nama)}</div>
        <div class="fin-total">${formatRupiah(total)}</div>
      </div>
    `).join('');
}

// ---------- Widget ringkasan mini (dipakai di Beranda Koperasi — Bagian C) ----------
export function renderRingkasanKeuanganKoperasi() {
  const cardsEl = document.getElementById('kopKeuanganCards');
  if (!cardsEl) return;
  const dari = document.getElementById('kopKeuanganFilterDari').value;
  const sampai = document.getElementById('kopKeuanganFilterSampai').value;
  const data = computeKoperasiKeuangan(dari, sampai);

  document.getElementById('kopKeuanganPengeluaran').textContent = formatRupiah(data.totalPengeluaran);
  document.getElementById('kopKeuanganPemasukan').textContent = formatRupiah(data.totalPemasukan);
  const saldoCard = document.getElementById('kopKeuanganSaldoCard');
  document.getElementById('kopKeuanganSaldo').textContent = formatRupiah(data.saldo);
  saldoCard.classList.toggle('danger', data.saldo < 0);
  saldoCard.classList.toggle('alt', data.saldo >= 0);

  document.getElementById('kopMarginKotor').textContent = formatRupiah(data.marginKotor);
  document.getElementById('kopBiayaOperasional').textContent = formatRupiah(data.totalBiayaOperasional);
  const profitCard = document.getElementById('kopProfitRealCard');
  document.getElementById('kopProfitReal').textContent = formatRupiah(data.profitReal);
  profitCard.classList.toggle('danger', data.profitReal < 0);
  profitCard.classList.toggle('alt', data.profitReal >= 0);
}

export function initRingkasanKeuanganKoperasiEvents() {
  document.getElementById('kopKeuanganFilterDari').addEventListener('change', renderRingkasanKeuanganKoperasi);
  document.getElementById('kopKeuanganFilterSampai').addEventListener('change', renderRingkasanKeuanganKoperasi);
  document.getElementById('btnKopKeuanganFilterReset').addEventListener('click', () => {
    document.getElementById('kopKeuanganFilterDari').value = '';
    document.getElementById('kopKeuanganFilterSampai').value = '';
    renderRingkasanKeuanganKoperasi();
  });
}

// ---------- Halaman penuh: Laporan Keuangan Koperasi (Bagian D) ----------
export function renderLaporanKeuanganKoperasi() {
  const totalPemasukanEl = document.getElementById('lkTotalPemasukan');
  if (!totalPemasukanEl) return;
  const dari = document.getElementById('lkFilterDari').value;
  const sampai = document.getElementById('lkFilterSampai').value;
  const data = computeKoperasiKeuangan(dari, sampai);

  totalPemasukanEl.textContent = formatRupiah(data.totalPemasukan);
  document.getElementById('lkTotalPengeluaran').textContent = formatRupiah(data.totalPengeluaran);
  document.getElementById('lkSaldo').textContent = formatRupiah(data.saldo);
  const saldoCard = document.getElementById('lkSaldoCard');
  saldoCard.classList.toggle('danger', data.saldo < 0);
  saldoCard.classList.toggle('alt', data.saldo >= 0);
  document.getElementById('lkSaldoLabel').textContent = data.saldo >= 0 ? 'Laba Bersih' : 'Rugi Bersih';

  document.getElementById('lkMarginKotor').textContent = formatRupiah(data.marginKotor);
  document.getElementById('lkBiayaOperasional').textContent = formatRupiah(data.totalBiayaOperasional);
  const profitCard = document.getElementById('lkProfitRealCard');
  document.getElementById('lkProfitReal').textContent = formatRupiah(data.profitReal);
  profitCard.classList.toggle('danger', data.profitReal < 0);
  profitCard.classList.toggle('alt', data.profitReal >= 0);

  const ledger = buildLedger(data);
  document.getElementById('lkLedger').innerHTML = ledger.length === 0
    ? `<div class="empty-state">Belum ada transaksi untuk rentang tanggal ini.</div>`
    : ledger.map(l => `
      <div class="fin-row fin-row--ledger">
        <div>${escapeHtml(l.tanggalDisplay)}</div>
        <div class="fin-name">${escapeHtml(l.keterangan)}</div>
        <div><span class="activity-badge activity-badge--${l.jenis === 'Pemasukan' ? 'tambah' : 'hapus'}">${l.jenis}</span></div>
        <div class="fin-total">${formatRupiah(l.jumlah)}</div>
      </div>
    `).join('');

  document.getElementById('lkBreakdownPengeluaran').innerHTML = finRowsHtml(buildBreakdownPengeluaran(data.pembelian));
  document.getElementById('lkBreakdownPemasukan').innerHTML = finRowsHtml(buildBreakdownPemasukan(data.notaList));
}

export function downloadLaporanKeuanganCsv() {
  const dari = document.getElementById('lkFilterDari').value;
  const sampai = document.getElementById('lkFilterSampai').value;
  const data = computeKoperasiKeuangan(dari, sampai);
  const ledger = buildLedger(data);

  if (ledger.length === 0) {
    alert('Tidak ada transaksi untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal', 'Keterangan', 'Jenis', 'Jumlah (Rp)'];
  const rows = ledger.map(l => [l.tanggalDisplay, l.keterangan, l.jenis, l.jumlah]);
  rows.push([]);
  rows.push(['TOTAL PEMASUKAN', '', '', data.totalPemasukan]);
  rows.push(['TOTAL PENGELUARAN', '', '', data.totalPengeluaran]);
  rows.push([data.saldo >= 0 ? 'LABA BERSIH' : 'RUGI BERSIH', '', '', data.saldo]);
  rows.push([]);
  rows.push(['MARGIN KOTOR (PO)', '', '', data.marginKotor]);
  rows.push(['BIAYA OPERASIONAL', '', '', data.totalBiayaOperasional]);
  rows.push(['TOTAL PROFIT REAL', '', '', data.profitReal]);

  downloadCsv(`Laporan-Keuangan-Koperasi-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function downloadLaporanKeuanganPdf() {
  const dari = document.getElementById('lkFilterDari').value;
  const sampai = document.getElementById('lkFilterSampai').value;
  const data = computeKoperasiKeuangan(dari, sampai);
  const ledger = buildLedger(data);
  const rangeLabel = dateRangeLabel(dari, sampai, formatDate);
  const saldoLabel = data.saldo >= 0 ? 'Laba Bersih' : 'Rugi Bersih';

  const body = `
    <h1>Laporan Keuangan Koperasi Bahan Makanan</h1>
    <div class="print-meta">Yayasan Rumah Sehat Indonesia · Periode: ${escapeHtml(rangeLabel)}</div>
    <div class="print-totals">
      <div class="print-total-box"><div class="lbl">Total Pemasukan</div><div class="val">${formatRupiah(data.totalPemasukan)}</div></div>
      <div class="print-total-box"><div class="lbl">Total Pengeluaran</div><div class="val">${formatRupiah(data.totalPengeluaran)}</div></div>
      <div class="print-total-box"><div class="lbl">${saldoLabel}</div><div class="val">${formatRupiah(data.saldo)}</div></div>
    </div>
    <div class="print-totals">
      <div class="print-total-box"><div class="lbl">Margin Kotor (PO)</div><div class="val">${formatRupiah(data.marginKotor)}</div></div>
      <div class="print-total-box"><div class="lbl">Biaya Operasional</div><div class="val">${formatRupiah(data.totalBiayaOperasional)}</div></div>
      <div class="print-total-box"><div class="lbl">Total Profit Real</div><div class="val">${formatRupiah(data.profitReal)}</div></div>
    </div>
    <h3>Rincian Transaksi</h3>
    <table>
      <thead><tr><th>Tanggal</th><th>Keterangan</th><th>Jenis</th><th>Jumlah</th></tr></thead>
      <tbody>
        ${ledger.map(l => `<tr><td>${escapeHtml(l.tanggalDisplay)}</td><td>${escapeHtml(l.keterangan)}</td><td>${l.jenis}</td><td>${formatRupiah(l.jumlah)}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3>Pengeluaran per Jenis Barang</h3>
    <table>
      <thead><tr><th>Barang</th><th>Total</th></tr></thead>
      <tbody>
        ${buildBreakdownPengeluaran(data.pembelian).map(([nama, total]) => `<tr><td>${escapeHtml(nama)}</td><td>${formatRupiah(total)}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3>Pemasukan per SPPG Tujuan</h3>
    <table>
      <thead><tr><th>SPPG</th><th>Total</th></tr></thead>
      <tbody>
        ${buildBreakdownPemasukan(data.notaList).map(([nama, total]) => `<tr><td>${escapeHtml(nama)}</td><td>${formatRupiah(total)}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
  printReport(body);
}

export function initLaporanKeuanganKoperasiEvents() {
  document.getElementById('lkFilterDari').addEventListener('change', renderLaporanKeuanganKoperasi);
  document.getElementById('lkFilterSampai').addEventListener('change', renderLaporanKeuanganKoperasi);
  document.getElementById('btnLkFilterReset').addEventListener('click', () => {
    document.getElementById('lkFilterDari').value = '';
    document.getElementById('lkFilterSampai').value = '';
    renderLaporanKeuanganKoperasi();
  });
  document.getElementById('btnDownloadLkCsv').addEventListener('click', downloadLaporanKeuanganCsv);
  document.getElementById('btnDownloadLkPdf').addEventListener('click', downloadLaporanKeuanganPdf);
}
