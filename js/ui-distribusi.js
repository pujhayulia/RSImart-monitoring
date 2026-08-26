// ---------- Distribusi & Pengiriman (form, log, estimasi harga) ----------
import { collection, addDoc, query, orderBy, limit, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { PRODUK, produkLabel, produkById, priceFor } from './data.js';
import { formatRupiah } from './utils.js';
import { renderDistItemHtml, wireDistItemActions } from './ui-dist-item.js';
import { ensureLokasiTersimpan } from './ui-lokasi.js';

export function initProdukSelects() {
  const opts = PRODUK.map(p => `<option value="${p.id}">${produkLabel(p)}</option>`).join('');
  const distProduk = document.getElementById('distProduk');
  distProduk.innerHTML = opts;

  const filterSel = document.getElementById('distFilterProduk');
  filterSel.innerHTML = `<option value="all">Semua Produk</option>` + opts;
  filterSel.addEventListener('change', renderDistLog);

  distProduk.addEventListener('change', updateHargaUI);
  document.getElementById('distTipeHarga').addEventListener('change', updateEstimasi);
  document.getElementById('distJumlah').addEventListener('input', updateEstimasi);
  document.getElementById('distDibayar').addEventListener('change', toggleMetodeWrap);

  updateHargaUI();
  toggleMetodeWrap();
}

export function toggleMetodeWrap() {
  const wrap = document.getElementById('distMetodeWrap');
  wrap.classList.toggle('hidden', document.getElementById('distDibayar').value !== 'sudah');
}

export function updateHargaUI() {
  const produk = produkById(document.getElementById('distProduk').value);
  document.getElementById('distSatuan').textContent = produk ? produk.satuan : '';
  const tipeWrap = document.getElementById('distTipeHargaWrap');
  const tipeSelect = document.getElementById('distTipeHarga');
  if (produk && produk.priceType === 'tier') {
    tipeWrap.classList.remove('hidden');
    tipeSelect.innerHTML = produk.tiers.map(t => `<option value="${t.label}">${t.label} — ${formatRupiah(t.price)}</option>`).join('');
  } else {
    tipeWrap.classList.add('hidden');
  }
  updateEstimasi();
}

export function updateEstimasi() {
  const produk = produkById(document.getElementById('distProduk').value);
  const jumlah = Number(document.getElementById('distJumlah').value) || 0;
  const tipe = document.getElementById('distTipeHarga').value;
  const harga = priceFor(produk, tipe);
  const total = harga * jumlah;
  document.getElementById('distEstimasi').textContent = jumlah > 0 ? formatRupiah(total) : '—';
  document.getElementById('distHargaSatuan').textContent = produk ? `${formatRupiah(harga)} / ${produk.satuan}` : '';
}

export function renderDistLog() {
  const logEl = document.getElementById('distLog');
  const filter = document.getElementById('distFilterProduk').value;
  const items = filter === 'all' ? state.lastDistItems : state.lastDistItems.filter(it => (it.produkId || 'galon19') === filter);

  if (items.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada catatan pengiriman untuk filter ini.</div>`;
    return;
  }
  logEl.innerHTML = items.map(it => renderDistItemHtml(it, { showProdukMeta: true })).join('');
  wireDistItemActions(logEl);
}

export function watchDistribusi(onChange) {
  const logEl = document.getElementById('distLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data pengiriman...</div>`;
  const q = query(collection(state.db, 'pengiriman'), orderBy('createdAt', 'desc'), limit(200));
  if (state.distUnsub) state.distUnsub();
  state.distUnsub = onSnapshot(q, (qs) => {
    state.lastDistItems = [];
    qs.forEach(d => state.lastDistItems.push({ id: d.id, ...d.data() }));
    if (state.lastDistItems.length === 0) {
      logEl.innerHTML = `<div class="empty-state">Belum ada catatan pengiriman. Tambahkan yang pertama di sebelah kiri.</div>`;
    } else {
      renderDistLog();
    }
    onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data pengiriman.</div>`;
  });
}

export async function saveDistribusi() {
  const tanggalPesan = document.getElementById('distTanggalPesan').value;
  const tanggalKirim = document.getElementById('distTanggalKirim').value;
  const tujuan = document.getElementById('distTujuan').value.trim();
  const produkId = document.getElementById('distProduk').value;
  const jumlah = document.getElementById('distJumlah').value;
  const keterangan = document.getElementById('distKeterangan').value.trim();
  const dibayar = document.getElementById('distDibayar').value === 'sudah';
  const metodeBayar = dibayar ? document.getElementById('distMetodeBayar').value : null;
  const produk = produkById(produkId);
  const tipeHarga = produk && produk.priceType === 'tier' ? document.getElementById('distTipeHarga').value : null;

  if (!tanggalPesan || !tanggalKirim || !tujuan || !jumlah || !produk) {
    alert('Mohon isi tanggal pesan, tanggal kirim, tujuan, produk, dan jumlah.');
    return;
  }
  const hargaSatuan = priceFor(produk, tipeHarga);
  const total = hargaSatuan * Number(jumlah);

  const entry = {
    tanggal: tanggalKirim, // dipakai untuk kompatibilitas & pengelompokan bulan di keuangan
    tanggalPesan, tanggalKirim,
    tujuan,
    produkId: produk.id,
    produkNama: produkLabel(produk),
    satuan: produk.satuan,
    jumlah: Number(jumlah),
    tipeHarga,
    hargaSatuan,
    total,
    dibayar,
    metodeBayar,
    keterangan,
    createdAt: Date.now()
  };
  const btn = document.getElementById('btnSaveDist');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    await addDoc(collection(state.db, 'pengiriman'), entry);
    await ensureLokasiTersimpan(tujuan);
    document.getElementById('distTujuan').value = '';
    document.getElementById('distJumlah').value = '';
    document.getElementById('distKeterangan').value = '';
    document.getElementById('distDibayar').value = 'belum';
    toggleMetodeWrap();
    updateEstimasi();
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan data pengiriman. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Pengiriman';
  }
}
