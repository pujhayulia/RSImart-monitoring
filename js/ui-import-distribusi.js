// ---------- Impor banyak catatan Pengiriman sekaligus dari file Excel/CSV ----------
// Mirip impor PO di Koperasi (js/ui-po-sppg.js) — baca semua sheet & semua tabel di tiap sheet, cari
// baris header lewat kecocokan kolom, lalu ubah tiap baris data jadi satu catatan pengiriman terpisah
// (beda dari Koperasi: satu PO = banyak barang dalam satu dokumen; satu pengiriman = satu dokumen
// sendiri, jadi tidak perlu logika pengelompokan tanggal seperti di Koperasi).
import { collection, doc, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { produkById, produkLabel, priceFor } from './data.js';
import { logActivity } from './activity-log.js';
import { ensureLokasiTersimpan } from './ui-lokasi.js';

// Alias nama kolom yang dikenali (dicocokkan setelah huruf kecil & spasi/underscore dibuang).
const KOLOM_DISTRIBUSI = {
  produk: ['produk', 'namaproduk', 'barang', 'item'],
  tujuan: ['tujuan', 'lokasi', 'pelanggan', 'customer', 'penerima', 'kirimke'],
  jumlah: ['jumlah', 'qty', 'quantity', 'banyak'],
  tanggalKirim: ['tanggalkirim', 'tglkirim', 'tanggalpengiriman', 'tanggal', 'tgl'],
  tanggalPesan: ['tanggalpesan', 'tglpesan'],
  harga: ['harga', 'hargasatuan', 'price'],
  dibayar: ['status', 'dibayar', 'pembayaran', 'bayar'],
};

function normalisasiHeaderKolom(h) {
  return String(h || '').toLowerCase().replace(/[\s_./-]+/g, '');
}

/** Cari field internal yang cocok dengan satu header kolom — exact match dulu, baru substring. */
function cocokkanKolomDistribusi(header) {
  const n = normalisasiHeaderKolom(header);
  for (const [field, aliases] of Object.entries(KOLOM_DISTRIBUSI)) {
    if (aliases.includes(n)) return field;
  }
  for (const field of ['produk', 'tujuan', 'harga', 'jumlah', 'tanggalKirim', 'tanggalPesan', 'dibayar']) {
    if (KOLOM_DISTRIBUSI[field].some(a => n.includes(a))) return field;
  }
  return null;
}

/** Cocokkan teks bebas nama produk dari file ke salah satu produk Air ARSI yang dikenal (katalog tetap,
 * cuma 6 macam) — bukan menebak bebas, cuma mencocokkan kata kunci pembeda tiap produk. */
function cariProdukDariTeks(teks) {
  const t = String(teks || '').toLowerCase();
  if (/piring/.test(t)) return produkById('sabunPiring');
  if (/lantai/.test(t)) return produkById('pembersihLantai');
  if (/tangan/.test(t)) return produkById('sabunTangan');
  if (/\b19\b/.test(t) || /galon/.test(t)) return produkById('galon19');
  if (/\b660\b/.test(t)) return produkById('botol660');
  if (/\b330\b/.test(t)) return produkById('botol330');
  if (/botol/.test(t)) return produkById('botol660');
  return null;
}

function statusDibayarDariTeks(teks) {
  const t = String(teks || '').toLowerCase().trim();
  return /lunas|sudah|ya|paid|done/.test(t);
}

// Sama seperti parseTanggalIndonesia di js/ui-po-sppg.js — tanggal boleh ditulis nama bulan disingkat
// (mis. "10 Sep 2026") kalau selnya berupa teks, bukan sel tanggal Excel asli.
const BULAN_INDONESIA_IDX = {
  jan: 0, januari: 0, feb: 1, februari: 1, mar: 2, maret: 2, apr: 3, april: 3, mei: 4,
  jun: 5, juni: 5, jul: 6, juli: 6, agt: 7, agu: 7, agustus: 7, sep: 8, september: 8,
  okt: 9, oktober: 9, nov: 10, november: 10, des: 11, desember: 11,
};

function parseTanggalFleksibel(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  // Format ISO/Excel umum: "2026-09-10" atau "10/9/2026".
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  // Format teks Indonesia: "10 September 2026" / "10 Sep 2026".
  const teks = s.toLowerCase().match(/(\d{1,2})\s+([a-zé]+)\s+(\d{4})/);
  if (teks) {
    const bulanIdx = BULAN_INDONESIA_IDX[teks[2]];
    if (bulanIdx !== undefined) return `${teks[3]}-${String(bulanIdx + 1).padStart(2, '0')}-${teks[1].padStart(2, '0')}`;
  }
  return '';
}

/** Cek apakah baris ke-i adalah baris header tabel pengiriman — harus cocok kolom Produk DAN minimal
 * satu kolom lain, supaya kata umum tidak salah kejebak (pola sama seperti impor PO Koperasi). */
function barisAdalahHeader(rows, i) {
  const map = {};
  rows[i].forEach((cell, idx) => {
    const field = cocokkanKolomDistribusi(cell);
    if (field && map[field] === undefined) map[field] = idx;
  });
  if (map.produk === undefined || Object.keys(map).length < 2) return null;

  let barisData = null;
  for (let j = i + 1; j < rows.length; j++) {
    if (rows[j].some(c => String(c ?? '').trim() !== '')) { barisData = rows[j]; break; }
  }
  if (!barisData) return null;
  if (map.jumlah !== undefined) {
    const v = barisData[map.jumlah];
    if (v === '' || v === undefined || v === null || !/\d/.test(String(v))) return null;
  }
  return map;
}

/** Baris ini masih cocok jadi data untuk kolomMap tertentu? (dipakai menentukan akhir satu blok tabel —
 * lihat catatan panjang di poBarisCocokDenganKolom, js/ui-po-sppg.js, untuk alasan pendekatan ini). */
function barisCocokDenganKolom(row, kolomMap) {
  const produk = String(row[kolomMap.produk] ?? '').trim();
  if (produk && !/[a-zA-Z]/.test(produk)) return false;
  if (kolomMap.jumlah !== undefined) {
    const j = String(row[kolomMap.jumlah] ?? '').trim();
    if (j && !/\d/.test(j)) return false;
  }
  return true;
}

function cariSemuaBlokHeader(rows) {
  const headers = [];
  for (let i = 0; i < rows.length; i++) {
    const map = barisAdalahHeader(rows, i);
    if (map) headers.push({ headerRowIdx: i, kolomMap: map });
  }
  return headers.map((h, idx) => {
    const batasBerikutnya = idx + 1 < headers.length ? headers[idx + 1].headerRowIdx : rows.length;
    let dataEnd = h.headerRowIdx + 1;
    while (dataEnd < batasBerikutnya && barisCocokDenganKolom(rows[dataEnd], h.kolomMap)) dataEnd++;
    return { headerRowIdx: h.headerRowIdx, kolomMap: h.kolomMap, dataEnd };
  });
}

/**
 * Baca file Excel/CSV berisi banyak baris pengiriman. Mengembalikan { entries, dilewati } — entries siap
 * dikirim ke Firestore (bentuknya sama seperti hasil saveDistribusi() di js/ui-distribusi.js), dilewati
 * berisi alasan tiap baris yang gagal diproses (produk tak dikenal, tanggal/jumlah tidak jelas, dst) supaya
 * bisa ditunjukkan ke pengguna, bukan didiamkan begitu saja.
 */
function bacaBarisDistribusi(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  if (workbook.SheetNames.length === 0) throw new Error('File kosong atau tidak ada sheet-nya.');

  const entries = [];
  const dilewati = [];
  let adaBlokTerbaca = false;

  workbook.SheetNames.forEach(sheetName => {
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    if (rawRows.length === 0) return;

    cariSemuaBlokHeader(rawRows).forEach(blok => {
      adaBlokTerbaca = true;
      for (let r = blok.headerRowIdx + 1; r < blok.dataEnd; r++) {
        const row = rawRows[r];
        const produkTeks = String(row[blok.kolomMap.produk] || '').trim();
        if (!produkTeks) continue; // baris kosong/pemisah, lewati diam-diam

        const tujuan = blok.kolomMap.tujuan !== undefined ? String(row[blok.kolomMap.tujuan] || '').trim() : '';
        const jumlah = blok.kolomMap.jumlah !== undefined ? Number(row[blok.kolomMap.jumlah]) : NaN;
        const tanggalKirim = blok.kolomMap.tanggalKirim !== undefined ? parseTanggalFleksibel(row[blok.kolomMap.tanggalKirim]) : '';
        const tanggalPesan = blok.kolomMap.tanggalPesan !== undefined ? parseTanggalFleksibel(row[blok.kolomMap.tanggalPesan]) : '';
        const produk = cariProdukDariTeks(produkTeks);
        const hargaIsian = blok.kolomMap.harga !== undefined ? Number(row[blok.kolomMap.harga]) : NaN;
        const dibayar = blok.kolomMap.dibayar !== undefined ? statusDibayarDariTeks(row[blok.kolomMap.dibayar]) : false;

        const ringkasBaris = `Sheet "${sheetName}" baris ${r + 1}: "${produkTeks}"${tujuan ? ' ke ' + tujuan : ''}`;
        if (!produk) { dilewati.push(`${ringkasBaris} — nama produk tidak dikenali (bukan salah satu dari 6 produk Air ARSI).`); continue; }
        if (!tujuan) { dilewati.push(`${ringkasBaris} — tujuan pengiriman kosong.`); continue; }
        if (!jumlah || isNaN(jumlah) || jumlah <= 0) { dilewati.push(`${ringkasBaris} — jumlah tidak jelas.`); continue; }
        if (!tanggalKirim) { dilewati.push(`${ringkasBaris} — tanggal kirim tidak terbaca.`); continue; }

        const tipeHarga = produk.priceType === 'tier' ? produk.tiers[0].label : null;
        const hargaSatuan = !isNaN(hargaIsian) && hargaIsian > 0 ? hargaIsian : priceFor(produk, tipeHarga);
        const total = Math.round(hargaSatuan * jumlah);

        entries.push({
          tanggal: tanggalKirim,
          tanggalPesan: tanggalPesan || tanggalKirim,
          tanggalKirim,
          tujuan,
          produkId: produk.id,
          produkNama: produkLabel(produk),
          satuan: produk.satuan,
          jumlah,
          tipeHarga,
          hargaSatuan,
          total,
          dibayar,
          metodeBayar: dibayar ? 'Tunai' : null,
          keterangan: '',
        });
      }
    });
  });

  if (!adaBlokTerbaca) {
    throw new Error('Kolom "Produk" tidak ditemukan di file ini.\n\nPastikan ada kolom dengan header seperti "Produk", "Barang", atau "Item", dan minimal satu kolom lain (Tujuan/Jumlah/Tanggal).');
  }
  return { entries, dilewati };
}

/** Buat banyak catatan pengiriman sekaligus lewat writeBatch — dipakai setelah bacaBarisDistribusi(). */
async function buatBanyakPengirimanDariFile(entries, namaFile) {
  let batch = writeBatch(state.db);
  let opsInBatch = 0;
  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    batch = writeBatch(state.db);
    opsInBatch = 0;
  };
  for (const entry of entries) {
    const ref = doc(collection(state.db, 'pengiriman'));
    batch.set(ref, {
      ...entry,
      createdAt: serverTimestamp(),
      createdBy: state.currentUserEmail,
    });
    opsInBatch += 1;
    if (opsInBatch >= 450) await flush();
  }
  await flush();

  const tujuanUnik = [...new Set(entries.map(e => e.tujuan))];
  for (const t of tujuanUnik) {
    await ensureLokasiTersimpan(t);
  }
}

/** Handler tombol "Impor dari File" di halaman Distribusi & Pengiriman. */
async function handleImportDistribusi(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const btn = document.getElementById('btnImportDistribusi');
  const labelAsli = btn ? btn.textContent : '';
  if (!['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'xlsb'].includes(ext)) {
    alert(`Jenis file ".${ext}" belum didukung untuk impor Distribusi. Coba file Excel/CSV.`);
    return;
  }
  if (typeof XLSX === 'undefined') {
    alert('Pembaca Excel belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Membaca file...'; }
  try {
    const { entries, dilewati } = bacaBarisDistribusi(await file.arrayBuffer());
    if (entries.length === 0) {
      throw new Error(`Tidak ada baris pengiriman yang berhasil terbaca dari file ini.${dilewati.length > 0 ? '\n\n' + dilewati.slice(0, 5).join('\n') : ''}`);
    }

    const tujuanUnik = [...new Set(entries.map(e => e.tujuan))];
    const tanggalUnik = [...new Set(entries.map(e => e.tanggalKirim))].sort();
    const preview = `${entries.length} pengiriman akan dibuat, untuk ${tujuanUnik.length} tujuan (${tujuanUnik.slice(0, 5).join(', ')}${tujuanUnik.length > 5 ? ', ...' : ''}), tanggal ${tanggalUnik[0]} s/d ${tanggalUnik[tanggalUnik.length - 1]}.${dilewati.length > 0 ? `\n\n${dilewati.length} baris dilewati (produk tidak dikenali/data tidak lengkap) — cek lagi manual nanti.` : ''}\n\nLanjutkan buat semua catatan pengiriman ini?`;
    if (!confirm(preview)) {
      alert('Impor dibatalkan. Tidak ada data yang ditambahkan.');
      return;
    }

    if (btn) btn.textContent = `Membuat ${entries.length} catatan...`;
    await buatBanyakPengirimanDariFile(entries, file.name);
    logActivity({
      action: 'tambah', modul: 'Distribusi',
      ringkasan: `Impor otomatis ${entries.length} pengiriman dari file "${file.name}" (${tujuanUnik.length} tujuan)`,
    });

    alert(`${entries.length} catatan pengiriman berhasil dibuat dari file.${dilewati.length > 0 ? `\n\n${dilewati.length} baris dilewati:\n${dilewati.slice(0, 10).join('\n')}${dilewati.length > 10 ? `\n...dan ${dilewati.length - 10} lainnya` : ''}\n\nTambahkan baris ini manual kalau perlu.` : ''}`);
  } catch (err) {
    console.error(err);
    alert(err.message || 'Gagal membaca file ini.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = labelAsli || '📄 Impor dari File'; }
  }
}

export function initImportDistribusiEvents() {
  const btn = document.getElementById('btnImportDistribusi');
  const input = document.getElementById('inputImportDistribusi');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', handleImportDistribusi);
}
