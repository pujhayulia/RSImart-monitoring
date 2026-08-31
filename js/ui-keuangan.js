// ---------- Rekap Keuangan (dihitung otomatis dari data pengiriman) ----------
import { state } from './state.js';
import { formatRupiah, formatDate, isDateStrInRange, escapeHtml } from './utils.js';
import { renderDistItemHtml, wireDistItemActions } from './ui-dist-item.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';

/** Dipakai bersama oleh halaman Keuangan dan ringkasan Beranda, supaya hitungannya satu sumber. */
export function computeKeuanganSummary(dari, sampai) {
  const curYm = new Date().toISOString().slice(0, 7);
  const hasFilter = !!(dari || sampai);

  let totalBulanIni = 0, totalSemua = 0, totalPeriode = 0, totalPiutang = 0;
  const perProduk = {};
  const perMetode = {};
  const piutangItems = [];

  state.lastDistItems.forEach(it => {
    const total = typeof it.total === 'number' ? it.total : 0;
    const lunas = !!it.dibayar;
    const tglKirim = it.tanggalKirim || it.tanggal || '';
    const inRange = !hasFilter || isDateStrInRange(tglKirim, dari, sampai);

    if (lunas) {
      totalSemua += total;
      if (tglKirim.slice(0, 7) === curYm) totalBulanIni += total;
      if (!inRange) return;
      totalPeriode += total;

      const key = it.produkNama || 'Lainnya';
      if (!perProduk[key]) perProduk[key] = { qty: 0, total: 0, satuan: it.satuan || '' };
      perProduk[key].qty += it.jumlah || 0;
      perProduk[key].total += total;

      const metodeKey = it.metodeBayar || 'Tunai';
      perMetode[metodeKey] = (perMetode[metodeKey] || 0) + total;
    } else {
      if (!inRange) return;
      totalPiutang += total;
      piutangItems.push(it);
    }
  });

  return { totalBulanIni, totalSemua, totalPeriode, totalPiutang, perProduk, perMetode, piutangItems, hasFilter };
}

export function renderKeuangan() {
  const bulanIniEl = document.getElementById('finBulanIni');
  const semuaEl = document.getElementById('finSemua');
  const semuaLblEl = document.getElementById('finSemuaLbl');
  const piutangEl = document.getElementById('finPiutang');
  const piutangLblEl = document.getElementById('finPiutangLbl');
  const tableEl = document.getElementById('finTable');
  const piutangListEl = document.getElementById('piutangList');
  const metodeTableEl = document.getElementById('finMetodeTable');
  if (!bulanIniEl) return;

  const dari = document.getElementById('keuanganFilterDari')?.value || '';
  const sampai = document.getElementById('keuanganFilterSampai')?.value || '';
  const { totalBulanIni, totalSemua, totalPeriode, totalPiutang, perProduk, perMetode, piutangItems, hasFilter }
    = computeKeuanganSummary(dari, sampai);

  bulanIniEl.textContent = formatRupiah(totalBulanIni);
  semuaEl.textContent = formatRupiah(hasFilter ? totalPeriode : totalSemua);
  if (semuaLblEl) semuaLblEl.textContent = hasFilter ? 'Pemasukan Periode Ini (Lunas)' : 'Pemasukan Semua Waktu (Lunas)';
  if (piutangEl) piutangEl.textContent = formatRupiah(totalPiutang);
  if (piutangLblEl) piutangLblEl.textContent = hasFilter ? 'Piutang Belum Dibayar (Periode Ini)' : 'Piutang Belum Dibayar';

  const rows = Object.entries(perProduk).sort((a, b) => b[1].total - a[1].total);
  tableEl.innerHTML = rows.length === 0
    ? `<div class="empty-state">Belum ada transaksi lunas.</div>`
    : rows.map(([nama, v]) => `
        <div class="fin-row">
          <div class="fin-name">${escapeHtml(nama)}</div>
          <div class="fin-qty">${v.qty} ${escapeHtml(v.satuan)}</div>
          <div class="fin-total">${formatRupiah(v.total)}</div>
        </div>
      `).join('');

  if (piutangListEl) {
    if (piutangItems.length === 0) {
      piutangListEl.innerHTML = `<div class="empty-state">Tidak ada piutang — semua transaksi sudah lunas.</div>`;
    } else {
      piutangListEl.innerHTML = piutangItems.map(it => renderDistItemHtml(it, { showProdukMeta: false })).join('');
      wireDistItemActions(piutangListEl);
    }
  }

  if (metodeTableEl) {
    const metodeRows = Object.entries(perMetode).sort((a, b) => b[1] - a[1]);
    metodeTableEl.innerHTML = metodeRows.length === 0
      ? `<div class="empty-state">Belum ada transaksi lunas.</div>`
      : metodeRows.map(([nama, total]) => `
        <div class="fin-row fin-row--2col">
          <div class="fin-name">${escapeHtml(nama)}</div>
          <div class="fin-total">${formatRupiah(total)}</div>
        </div>
      `).join('');
  }
}

export function downloadLaporanKeuangan() {
  const dari = document.getElementById('keuanganFilterDari').value;
  const sampai = document.getElementById('keuanganFilterSampai').value;
  const items = (!dari && !sampai)
    ? state.lastDistItems
    : state.lastDistItems.filter(it => isDateStrInRange(it.tanggalKirim || it.tanggal, dari, sampai));

  if (items.length === 0) {
    alert('Tidak ada data pengiriman untuk rentang tanggal ini.');
    return;
  }

  const headers = ['Tanggal Kirim', 'Tanggal Pesan', 'Tujuan', 'Produk', 'Jumlah', 'Satuan', 'Harga Satuan (Rp)', 'Total (Rp)', 'Status Bayar', 'Metode Bayar', 'Keterangan', 'Diinput Oleh'];
  const rows = items.map(it => [
    formatDate(it.tanggalKirim || it.tanggal), formatDate(it.tanggalPesan || it.tanggal), it.tujuan,
    it.produkNama || '', it.jumlah, it.satuan || '', it.hargaSatuan ?? '', it.total ?? '',
    it.dibayar ? 'Lunas' : 'Belum Dibayar', it.metodeBayar || '', it.keterangan || '', it.createdBy || '',
  ]);

  let totalLunas = 0, totalPiutang = 0;
  items.forEach(it => {
    const total = typeof it.total === 'number' ? it.total : 0;
    if (it.dibayar) totalLunas += total; else totalPiutang += total;
  });
  rows.push([]);
  rows.push(['TOTAL PEMASUKAN (LUNAS)', '', '', '', '', '', '', totalLunas]);
  rows.push(['TOTAL PIUTANG (BELUM DIBAYAR)', '', '', '', '', '', '', totalPiutang]);

  downloadCsv(`Laporan-Keuangan-RSI-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initKeuanganReportEvents() {
  document.getElementById('btnDownloadKeuangan').addEventListener('click', downloadLaporanKeuangan);
  ['keuanganFilterDari', 'keuanganFilterSampai'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderKeuangan);
  });
}
