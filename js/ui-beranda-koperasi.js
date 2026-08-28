// ---------- Beranda Koperasi: ringkasan pembelian & distribusi ke SPPG ----------
import { state } from './state.js';
import { formatRupiah } from './utils.js';
import { computePembelianSummary } from './ui-pembelian.js';
import { computeDistribusiSppgSummary } from './ui-distribusi-sppg.js';
import { renderRingkasanKeuanganKoperasi, initRingkasanKeuanganKoperasiEvents } from './ui-laporan-keuangan-koperasi.js';
import { navigateTo } from './router.js';

const ACTION_STATUS = {
  menunggu_pembelian: 'Menunggu Pembelian',
  menunggu_persetujuan: 'Menunggu Persetujuan SPPG',
  disetujui: 'Disetujui — Siap Kirim',
};

function renderPerluTindakan() {
  const row = document.getElementById('berandaKopActionRow');
  if (!row) return;

  const counts = { menunggu_pembelian: 0, menunggu_persetujuan: 0, disetujui: 0 };
  (state.lastPoSppgItems || []).forEach(po => {
    if (counts[po.status] !== undefined) counts[po.status] += 1;
  });
  const total = counts.menunggu_pembelian + counts.menunggu_persetujuan + counts.disetujui;

  if (total === 0) {
    row.innerHTML = `<div class="action-empty">✓ Semua PO sudah ditindaklanjuti — tidak ada yang menunggu saat ini.</div>`;
    return;
  }

  row.innerHTML = Object.keys(ACTION_STATUS)
    .filter(status => counts[status] > 0)
    .map(status => `
      <button type="button" class="action-pill action-pill--${status}" data-status="${status}">
        <span class="count">${counts[status]}</span>
        <span class="lbl">${ACTION_STATUS[status]}</span>
      </button>
    `).join('');

  row.querySelectorAll('.action-pill').forEach(btn => {
    btn.addEventListener('click', () => navigateTo('koperasi', 'posppg'));
  });
}

export function renderBerandaKoperasi() {
  const el = document.getElementById('berandaKopTotalBelanja');
  if (!el) return;

  const pembelian = computePembelianSummary();
  const sppg = computeDistribusiSppgSummary();

  document.getElementById('berandaKopTotalBelanja').textContent = formatRupiah(pembelian.totalBelanja);
  document.getElementById('berandaKopTransaksi').textContent = String(pembelian.jumlahTransaksi);
  document.getElementById('berandaKopNilaiDistribusi').textContent = formatRupiah(sppg.totalNilai);
  document.getElementById('berandaKopItemDistribusi').textContent = String(sppg.jumlahItem);

  renderPerluTindakan();
  renderRingkasanKeuanganKoperasi();
}

export function initBerandaKoperasiEvents() {
  initRingkasanKeuanganKoperasiEvents();
}
