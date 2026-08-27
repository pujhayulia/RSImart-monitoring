// ---------- Beranda: ringkasan cepat stok & keuangan ----------
import { state } from './state.js';
import { formatRupiah } from './utils.js';
import { computeKeuanganSummary } from './ui-keuangan.js';

export function renderBeranda() {
  const stokIsiEl = document.getElementById('berandaStokIsi');
  if (!stokIsiEl) return;

  const rekap = state.currentGudangData;
  const hasStok = rekap && rekap.isi !== null && rekap.isi !== undefined;
  stokIsiEl.textContent = hasStok ? `${rekap.isi} galon` : '–';
  document.getElementById('berandaStokKosong').textContent = hasStok ? `${rekap.kosong ?? '–'} galon` : '–';

  const { totalBulanIni, totalPiutang } = computeKeuanganSummary();
  document.getElementById('berandaBulanIni').textContent = formatRupiah(totalBulanIni);
  document.getElementById('berandaPiutang').textContent = formatRupiah(totalPiutang);
}
