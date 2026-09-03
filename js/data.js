// ---------- Data produk & lokasi awal ----------

export const PRODUK = [
  { id: 'galon19', name: 'Air ARSI', size: 'Galon 19 Liter', icon: 'galon', satuan: 'galon', priceType: 'single', price: 21000 },
  { id: 'botol660', name: 'Air ARSI', size: 'Botol 660 ml', icon: 'botol', satuan: 'botol', priceType: 'single', price: 39000 },
  { id: 'botol330', name: 'Air ARSI', size: 'Botol 330 ml', icon: 'botol', satuan: 'botol', priceType: 'single', price: 35000 },
  { id: 'sabunPiring', name: 'Sabun Cuci Piring & Ompreng', size: '5 Liter', icon: 'jerigen', satuan: 'jerigen', priceType: 'tier', tiers: [{ label: 'Grosir', price: 55000 }, { label: 'Agen', price: 60000 }] },
  { id: 'pembersihLantai', name: 'Pembersih Lantai', size: '5 Liter', icon: 'jerigen', satuan: 'jerigen', priceType: 'tier', tiers: [{ label: 'Grosir', price: 53000 }, { label: 'Agen', price: 62400 }] },
  { id: 'sabunTangan', name: 'Sabun Cuci Tangan', size: '5 Liter', icon: 'jerigen', satuan: 'jerigen', priceType: 'tier', tiers: [{ label: 'Grosir', price: 83000 }, { label: 'Agen', price: 91500 }] },
];

export const ICONS = {
  galon: '<svg viewBox="0 0 24 24" fill="none" stroke="#1668B0" stroke-width="1.8"><path d="M9 3h6v3l2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-2V3z"/></svg>',
  botol: '<svg viewBox="0 0 24 24" fill="none" stroke="#1668B0" stroke-width="1.8"><path d="M10 2h4v3l1.5 2v13a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 20V7L10 5V2z"/></svg>',
  jerigen: '<svg viewBox="0 0 24 24" fill="none" stroke="#2F8F4E" stroke-width="1.8"><rect x="5" y="6" width="14" height="15" rx="2"/><path d="M9 6V4h6v2"/></svg>',
};

export const SEED_LOKASI = ['Dapur Nambo', 'Dapur Meruya', 'Sudimara/Ciledug', 'BTN', 'Depnaker', 'Rumah Pak Abay'];

/** Kop surat & info rekening Koperasi — dipakai untuk cetak Invoice/Berita Acara ke SPPG. */
export const KOPERASI_INFO = {
  nama: 'Koperasi Niaga Indonesia Sejahtera',
  namaSingkat: 'Koperasi NIS',
  alamatBaris: ['Jl. Hos Cokroaminoto No 11', 'RT.001/RW.07, Sudimara Jaya.', 'Kec. Ciledug, Kota Tangerang, Banten 15151'],
  alamat: 'Jl. Hos Cokroaminoto No 11, RT.001/RW.07, Sudimara Jaya, Kec. Ciledug, Kota Tangerang, Banten 15151',
  kota: 'Tangerang',
  bankNama: 'BTN',
  bankRekening: '43.01.88.000934.7',
  bankAtasNama: 'Koperasi Konsumen Niaga Indonesia Sejahtera',
  penandaTangan: 'Muh.Ghufron',
};

export const SEED_DATE = '2026-07-16';
export const SEED_GUDANG = { isi: 133, kosong: 387, peredaran: 520, stokProduk: {} };

export const PRODUK_NON_GALON = PRODUK.filter(p => p.id !== 'galon19');

export function produkLabel(p) {
  return `${p.name} — ${p.size}`;
}

export function produkById(id) {
  return PRODUK.find(p => p.id === id);
}

export function priceFor(produk, tipe) {
  if (!produk) return 0;
  if (produk.priceType === 'single') return produk.price;
  const t = produk.tiers.find(t => t.label === tipe) || produk.tiers[0];
  return t.price;
}
