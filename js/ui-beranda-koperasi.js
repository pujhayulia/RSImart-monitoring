// ---------- Beranda Koperasi: ringkasan pembelian & distribusi ke SPPG ----------
import { formatRupiah } from './utils.js';
import { computePembelianSummary } from './ui-pembelian.js';
import { computeDistribusiSppgSummary } from './ui-distribusi-sppg.js';
import { renderRingkasanKeuanganKoperasi, initRingkasanKeuanganKoperasiEvents } from './ui-laporan-keuangan-koperasi.js';

export function renderBerandaKoperasi() {
  const el = document.getElementById('berandaKopTotalBelanja');
  if (!el) return;

  const pembelian = computePembelianSummary();
  const sppg = computeDistribusiSppgSummary();

  document.getElementById('berandaKopTotalBelanja').textContent = formatRupiah(pembelian.totalBelanja);
  document.getElementById('berandaKopTransaksi').textContent = String(pembelian.jumlahTransaksi);
  document.getElementById('berandaKopNilaiDistribusi').textContent = formatRupiah(sppg.totalNilai);
  document.getElementById('berandaKopItemDistribusi').textContent = String(sppg.jumlahItem);

  renderRingkasanKeuanganKoperasi();
}

export function initBerandaKoperasiEvents() {
  initRingkasanKeuanganKoperasiEvents();
}
