// ---------- Rekap Keuangan (dihitung otomatis dari data pengiriman) ----------
import { state } from './state.js';
import { formatRupiah, escapeHtml } from './utils.js';
import { renderDistItemHtml, wireDistItemActions } from './ui-dist-item.js';

export function renderKeuangan() {
  const bulanIniEl = document.getElementById('finBulanIni');
  const semuaEl = document.getElementById('finSemua');
  const piutangEl = document.getElementById('finPiutang');
  const tableEl = document.getElementById('finTable');
  const piutangListEl = document.getElementById('piutangList');
  const metodeTableEl = document.getElementById('finMetodeTable');
  if (!bulanIniEl) return;

  const curYm = new Date().toISOString().slice(0, 7);

  let totalBulanIni = 0, totalSemua = 0, totalPiutang = 0;
  const perProduk = {};
  const perMetode = {};
  const piutangItems = [];

  state.lastDistItems.forEach(it => {
    const total = typeof it.total === 'number' ? it.total : 0;
    const lunas = !!it.dibayar;
    const tglKirim = it.tanggalKirim || it.tanggal || '';

    if (lunas) {
      totalSemua += total;
      if (tglKirim.slice(0, 7) === curYm) totalBulanIni += total;

      const key = it.produkNama || 'Lainnya';
      if (!perProduk[key]) perProduk[key] = { qty: 0, total: 0, satuan: it.satuan || '' };
      perProduk[key].qty += it.jumlah || 0;
      perProduk[key].total += total;

      const metodeKey = it.metodeBayar || 'Tunai';
      perMetode[metodeKey] = (perMetode[metodeKey] || 0) + total;
    } else {
      totalPiutang += total;
      piutangItems.push(it);
    }
  });

  bulanIniEl.textContent = formatRupiah(totalBulanIni);
  semuaEl.textContent = formatRupiah(totalSemua);
  if (piutangEl) piutangEl.textContent = formatRupiah(totalPiutang);

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
