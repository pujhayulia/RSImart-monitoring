// ---------- Koperasi Bahan Makanan — PO dari SPPG: alur pesanan sampai invoice ----------
// Satu PO = satu dokumen di collection "poSppg", berisi array `items` (mirip
// Distribusi SPPG). Status PO berjalan bertahap:
//   menunggu_pembelian -> menunggu_persetujuan -> disetujui/ditolak -> terkirim
// Saat "disetujui", PO bisa dijadikan Nota Pengiriman (lewat state.poPrefill,
// dibaca oleh ui-distribusi-sppg.js). Saat "terkirim", PO bisa dicetak jadi
// Invoice/Berita Acara (nomor invoice otomatis, format INV/{tahun}/{urut}).
import {
  collection, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, onSnapshot, serverTimestamp,
  writeBatch, getDocs, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { KOPERASI_INFO } from './data.js';
import { formatRupiah, formatDate, formatTimestamp, isDateStrInRange, escapeHtml, todayIso, monthRange } from './utils.js';
import { logActivity } from './activity-log.js';
import { downloadCsv, dateRangeFileTag } from './csv-export.js';
import { printReport } from './print-report.js';
import { navigateTo } from './router.js';
import { MARGIN_LAMA_BATCH, MARGIN_LAMA_DATA } from './margin-lama-data.js';

// Batch lama (sebelum ada data pembelian/margin) — dibersihkan otomatis saat arsip baru diimpor.
const OLD_PO_LAMA_BATCH = 'arsip-po-2026-08';

const LOGO_URL = 'assets/invoice/logo-koperasi.png';
const STEMPEL_URL = 'assets/invoice/stempel-koperasi.png';
const TTD_URL = 'assets/invoice/ttd-koperasi.jpg';

/** "Dapur SPPG Sudimara Jaya" -> "Dapur_SPPG_Sudimara_Jaya" — dipakai untuk nama file unduhan. */
function slugifyTujuan(tujuan) {
  return (tujuan || 'SPPG').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
}

/** "2026-08-24" -> "24Agu2026" — dipakai untuk nama file unduhan. */
function fileDateTag(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d}${bulan[parseInt(m, 10) - 1]}${y}`;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Kelompokkan baris hasil impor file per tanggal — dipakai saat satu file mencakup beberapa tanggal PO
 * sekaligus (mis. PO satu minggu penuh), supaya tiap tanggal jadi PO-nya sendiri, bukan tercampur jadi satu. */
function poKelompokkanPerTanggal(rows) {
  const map = new Map();
  const tanpaTanggal = [];
  rows.forEach(r => {
    if (!r.tanggal) { tanpaTanggal.push(r); return; }
    if (!map.has(r.tanggal)) map.set(r.tanggal, []);
    map.get(r.tanggal).push(r);
  });
  const kelompok = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tanggal, items]) => ({ tanggal, items }));
  return { kelompok, tanpaTanggal };
}

/** Buat satu PO baru (status menunggu_pembelian) per kelompok tanggal, langsung ke Firestore lewat
 * writeBatch — dipakai saat import file berisi beberapa tanggal PO sekaligus (lihat poKelompokkanPerTanggal). */
async function poBuatBanyakPoDariFile(kelompok, namaSppg, namaFile) {
  let batch = writeBatch(state.db);
  let opsInBatch = 0;
  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    batch = writeBatch(state.db);
    opsInBatch = 0;
  };
  for (const grup of kelompok) {
    const poRef = doc(collection(state.db, 'poSppg'));
    const items = grup.items.map((r, idx) => ({
      namaBarang: r.namaBarang,
      jumlah: r.jumlah === '' || r.jumlah === undefined ? null : Number(r.jumlah),
      satuan: r.satuan || '',
      hargaRencana: r.harga === '' || r.harga === undefined ? null : Number(r.harga),
      hargaFinal: null,
      itemId: `${poRef.id}-i${idx}`,
    }));
    batch.set(poRef, {
      tanggalPo: grup.tanggal,
      tujuanSppg: namaSppg,
      items,
      catatan: `Diimpor otomatis dari file "${namaFile}"`,
      status: 'menunggu_pembelian',
      distribusiId: null,
      invoiceNomor: null,
      createdAt: serverTimestamp(),
      createdBy: state.currentUserEmail,
    });
    opsInBatch += 1;
    if (opsInBatch >= 450) await flush();
  }
  await flush();
}

/** Kunci stabil untuk satu baris barang PO — dipakai Pembelian untuk menaut ke barang PO tertentu.
 * PO lama (sebelum fitur ini ada) belum punya `itemId` tersimpan, jadi jatuh ke index sebagai fallback. */
export function poItemKey(item, index) {
  return item.itemId || ('idx' + index);
}

function invoiceHeadCompanyHtml() {
  return `
    <div class="invoice-head-company">
      <img class="invoice-logo" src="${LOGO_URL}" alt="Logo ${escapeHtml(KOPERASI_INFO.namaSingkat)}">
      <div>
        <b>${escapeHtml(KOPERASI_INFO.nama.toUpperCase())}</b>
        ${KOPERASI_INFO.alamatBaris.map(line => `<div class="addr">${escapeHtml(line)}</div>`).join('')}
      </div>
    </div>`;
}

const STATUS_LABEL = {
  menunggu_pembelian: 'Menunggu Pembelian',
  menunggu_persetujuan: 'Menunggu Persetujuan SPPG',
  disetujui: 'Disetujui — Siap Kirim',
  ditolak: 'Ditolak',
  terkirim: 'Terkirim',
};

let rowCounter = 0;
let editingId = null;
let confirmExpandId = null; // PO yang sedang dibuka form "Konfirmasi Harga"-nya
let invoiceExpandId = null; // PO yang sedang dibuka form Potongan/PPN sebelum cetak invoice

function itemRowHtml(rowId) {
  return `
    <div class="nota-item-row" data-rowid="${rowId}">
      <input class="nir-nama" placeholder="Nama barang">
      <div class="nota-item-row-sub">
        <input class="nir-jumlah" type="number" placeholder="Jumlah">
        <input class="nir-satuan" list="satuanList" placeholder="Satuan">
        <input class="nir-harga" type="number" placeholder="Harga satuan rencana (opsional)">
        <button type="button" class="nir-remove" data-rowid="${rowId}" title="Hapus baris ini">✕</button>
      </div>
    </div>`;
}

function addItemRow(prefill) {
  rowCounter += 1;
  const wrap = document.getElementById('poItemRows');
  wrap.insertAdjacentHTML('beforeend', itemRowHtml(rowCounter));
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowCounter}"]`);
  row.querySelector('.nir-remove').addEventListener('click', () => removeItemRow(rowCounter));
  if (prefill) {
    row.querySelector('.nir-nama').value = prefill.namaBarang || '';
    row.querySelector('.nir-jumlah').value = prefill.jumlah ?? '';
    row.querySelector('.nir-satuan').value = prefill.satuan || '';
    row.querySelector('.nir-harga').value = prefill.hargaRencana ?? '';
    if (prefill.itemId) row.dataset.itemid = prefill.itemId;
  }
}

function removeItemRow(rowId) {
  const wrap = document.getElementById('poItemRows');
  const row = wrap.querySelector(`.nota-item-row[data-rowid="${rowId}"]`);
  if (row) row.remove();
  if (wrap.children.length === 0) addItemRow();
}

function resetItemRows() {
  document.getElementById('poItemRows').innerHTML = '';
  rowCounter = 0;
  addItemRow();
}

// Alias nama kolom Excel yang dikenali (dicocokkan setelah huruf kecil & spasi/underscore dibuang) — supaya
// pengguna tidak harus persis "Nama Barang", "nama_barang" atau "Barang" saja juga kena.
const KOLOM_PO_EXCEL = {
  namaBarang: ['namabarang', 'namabahan', 'nama', 'barang', 'bahan', 'item', 'produk', 'deskripsi'],
  jumlah: ['jumlah', 'qty', 'quantity', 'banyak', 'qtypesan', 'kebutuhan'],
  satuan: ['satuan', 'unit', 'uom'],
  harga: ['harga', 'hargasatuan', 'hargarencana', 'hargasatuanrencana', 'price'],
  tanggal: ['tanggalpengiriman', 'tanggalkirim', 'tglpengiriman', 'tglkirim', 'tanggalpo', 'tanggal', 'tgl'],
};

function normalisasiHeaderKolom(h) {
  return String(h || '').toLowerCase().replace(/[\s_./-]+/g, '');
}

/**
 * Cari field internal (namaBarang/jumlah/satuan/harga/tanggal) yang cocok dengan satu header kolom Excel. Dicek
 * exact match dulu di semua field, baru substring — dan untuk substring, "harga" dicek sebelum "satuan"
 * supaya header seperti "Harga Satuan" tidak salah kejebak ke field satuan gara-gara mengandung kata "satuan".
 */
function cocokkanKolomPo(header) {
  const n = normalisasiHeaderKolom(header);
  for (const [field, aliases] of Object.entries(KOLOM_PO_EXCEL)) {
    if (aliases.includes(n)) return field;
  }
  for (const field of ['namaBarang', 'harga', 'jumlah', 'satuan', 'tanggal']) {
    if (KOLOM_PO_EXCEL[field].some(a => n.includes(a))) return field;
  }
  return null;
}

// Nama & singkatan bulan Indonesia — dipakai buat mengenali tanggal seperti "Minggu, 23 Agustus 2026"
// atau "31 Agt 2026" (banyak PO nyata nulis bulan disingkat) dari teks bebas, bukan sel tanggal Excel asli.
const BULAN_INDONESIA_IDX = {
  jan: 0, januari: 0, feb: 1, februari: 1, mar: 2, maret: 2, apr: 3, april: 3, mei: 4,
  jun: 5, juni: 5, jul: 6, juli: 6, agt: 7, agu: 7, agustus: 7, sep: 8, september: 8,
  okt: 9, oktober: 9, nov: 10, november: 10, des: 11, desember: 11,
};

/** Ubah nilai kolom tanggal (teks Indonesia, boleh disingkat, atau objek Date dari Excel) jadi format ISO "YYYY-MM-DD" untuk <input type="date">. */
function parseTanggalIndonesia(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).toLowerCase().match(/(\d{1,2})\s+([a-zé]+)\s+(\d{4})/);
  if (!m) return '';
  const bulanIdx = BULAN_INDONESIA_IDX[m[2]];
  if (bulanIdx === undefined) return '';
  return `${m[3]}-${String(bulanIdx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Cari tanggal terdekat SEBELUM suatu baris (mundur, maks 15 baris) — dipakai saat tabel tidak punya
 * kolom Tanggal Pengiriman sendiri tapi tanggalnya ditulis sebagai judul berdiri sendiri di atas tabel
 * (pola umum: "Senin, 31 Agt 2026" di baris tersendiri, baru baris header tabel di bawahnya). */
function poCariTanggalTerdekatSebelum(rows, batasBarisIdx) {
  for (let i = batasBarisIdx - 1; i >= 0 && i >= batasBarisIdx - 15; i--) {
    for (const cell of rows[i]) {
      const t = parseTanggalIndonesia(cell);
      if (t) return t;
    }
  }
  return '';
}

/**
 * Cari nama SPPG dari blok judul di atas tabel barang (baris sebelum baris header) — file PO nyata selalu
 * menyebutkan nama SPPG tujuan secara eksplisit di sana (mis. sel tersendiri "SPPG SUDIMARA JAYA 2"), jadi
 * dicari APA ADANYA dari teksnya, bukan ditebak dari nama file atau data lain.
 */
function poCariNamaSppg(rows, batasBarisHeader) {
  const batas = batasBarisHeader === -1 ? rows.length : batasBarisHeader;
  for (let i = 0; i < batas; i++) {
    for (const cell of rows[i]) {
      const s = String(cell ?? '').trim();
      if (/^sppg\b/i.test(s)) {
        return s.split(/\s+/).map(w => {
          if (/^sppg$/i.test(w)) return 'SPPG';
          if (/^\d+$/.test(w)) return w;
          return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        }).join(' ');
      }
    }
  }
  return '';
}

/**
 * Cek apakah SATU baris (rows[i]) adalah baris header tabel barang PO — dipakai bareng oleh pembaca Excel
 * & tabel Word. Baris header harus cocok kolom Nama Barang DAN minimal satu kolom lain (Jumlah/Satuan/
 * Harga) sekaligus — kalau cuma mengandalkan satu kata seperti "barang"/"bahan", teks biasa yang kebetulan
 * mengandung kata itu (judul dokumen "...Bahan Baku", nama menu "Pisang Barangan", dst) gampang salah
 * kejebak. Sebagai pengaman kedua, baris data pertama sesudahnya juga dicek: kalau kolom Jumlah kedeteksi,
 * isinya di baris itu harus mengandung angka — soalnya baris header sungguhan selalu langsung diikuti data
 * asli, sedangkan baris yang salah kejebak (blok menu/judul) diikuti baris teks lain juga.
 */
function poBarisAdalahHeader(rows, i) {
  const map = {};
  rows[i].forEach((cell, idx) => {
    const field = cocokkanKolomPo(cell);
    if (field && map[field] === undefined) map[field] = idx;
  });
  if (map.namaBarang === undefined || Object.keys(map).length < 2) return null;

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

function poCariBarisHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const map = poBarisAdalahHeader(rows, i);
    if (map) return { headerRowIdx: i, kolomMap: map };
  }
  return null;
}

/** Baris ini masih cocok jadi data barang untuk kolomMap tertentu? Nama barang asli selalu ada hurufnya
 * (angka murni berarti kolom lain, mis. baris tabel ringkasan porsi/anggaran); begitu juga kolom Jumlah
 * kalau terisi harus ada angkanya. Sel kosong tetap dianggap cocok (baris Total/pemisah, disaring belakangan
 * lewat pengecekan Nama Barang wajib terisi) — dipakai poCariSemuaBlokHeader() menentukan akhir satu blok. */
function poBarisCocokDenganKolom(row, kolomMap) {
  const nama = String(row[kolomMap.namaBarang] ?? '').trim();
  if (nama && !/[a-zA-Z]/.test(nama)) return false;
  if (kolomMap.jumlah !== undefined) {
    const j = String(row[kolomMap.jumlah] ?? '').trim();
    if (j && !/\d/.test(j)) return false;
  }
  return true;
}

/**
 * Cari SEMUA blok tabel barang dalam satu sheet (bukan cuma yang pertama) — beberapa PO nyata punya lebih
 * dari satu tabel barang per sheet (mis. "Menu Porsi Kecil"/"Menu Porsi Besar" masing-masing tabel sendiri
 * untuk kelompok penerima berbeda, atau tabel ringkasan porsi/anggaran di bawah tabel barang sungguhan).
 * Batas antar blok: baris header baru (kalau ada), ATAU baris pertama yang sudah tidak cocok lagi sebagai
 * data untuk kolom blok ini (lihat poBarisCocokDenganKolom) — jadi baris kosong/"Total" di tengah SATU
 * tabel logis yang sama tetap ikut (tidak memotong blok), tapi begitu masuk ke tabel lain yang bentuknya
 * beda (mis. kolom Nama Barang isinya jadi angka semua), blok berhenti di situ. Tanggal tiap blok: dari
 * kolom Tanggal Pengiriman kalau ada, atau kalau tidak ada kolom itu, dicari dari judul tanggal berdiri
 * sendiri tepat di atas headernya (lihat poCariTanggalTerdekatSebelum) — pola umum saat tanggal ditulis
 * sebagai judul, bukan per kolom.
 */
function poCariSemuaBlokHeader(rows) {
  const headers = [];
  for (let i = 0; i < rows.length; i++) {
    const map = poBarisAdalahHeader(rows, i);
    if (map) headers.push({ headerRowIdx: i, kolomMap: map });
  }
  return headers.map((h, idx) => {
    const batasBerikutnya = idx + 1 < headers.length ? headers[idx + 1].headerRowIdx : rows.length;
    let dataEnd = h.headerRowIdx + 1;
    while (dataEnd < batasBerikutnya && poBarisCocokDenganKolom(rows[dataEnd], h.kolomMap)) dataEnd++;
    return {
      headerRowIdx: h.headerRowIdx,
      kolomMap: h.kolomMap,
      dataEnd,
      tanggalBlok: h.kolomMap.tanggal !== undefined ? null : poCariTanggalTerdekatSebelum(rows, h.headerRowIdx),
    };
  });
}

// Satuan yang dikenali saat menebak isi baris teks bebas (PDF/Word/foto) — dipakai poParseBarisTeks().
const SATUAN_DIKENAL_TEKS = ['kg', 'gram', 'gr', 'liter', 'ltr', 'pcs', 'pc', 'ikat', 'papan', 'dus', 'karung', 'botol', 'buah', 'ekor', 'sisir', 'bungkus', 'pack', 'lembar', 'unit', 'box', 'renceng'];

/**
 * Pengaman terakhir: kalau ternyata kolom Nama Barang KEMBALI salah kedeteksi (mis. kena kolom Satuan),
 * hasilnya akan didominasi teks satuan ("Kg"/"Pcs"/dst) bukan nama barang sungguhan. Daripada diam-diam
 * mengimpor barang salah, lebih baik gagal dengan pesan jelas supaya pengguna sadar dan cek filenya manual.
 */
function poHasilImportMasukAkal(rows) {
  if (rows.length === 0) return true;
  const satuanSet = new Set(SATUAN_DIKENAL_TEKS);
  const kenaSatuanSaja = rows.filter(r => satuanSet.has(r.namaBarang.trim().toLowerCase())).length;
  return kenaSatuanSaja <= rows.length / 2;
}

/**
 * Tebak nama barang/jumlah/satuan/harga dari SATU baris teks bebas (hasil ekstraksi PDF/Word/OCR foto,
 * yang tidak punya struktur kolom seperti Excel). Angka terakhir yang cukup besar (>=100) dianggap harga,
 * angka lain sebelumnya dianggap jumlah, kata yang cocok daftar satuan dianggap satuan, sisanya nama barang.
 * Ini cuma tebakan kasar — makanya hasil impor dari jenis file ini selalu perlu diperiksa manual.
 */
function poParseBarisTeks(line) {
  const raw = line.trim();
  if (!raw) return null;
  const text = raw.replace(/^\d+[.)]\s*/, ''); // buang nomor urut di depan baris, mis. "1. " / "2) "
  const numberRe = /\d+(?:[.,]\d+)*/g;
  const numbers = [...text.matchAll(numberRe)];
  if (numbers.length === 0) return null;

  const parseNum = (s) => {
    // Format ribuan ala Indonesia: tiap kelompok setelah titik/koma persis 3 digit (600.000, 1.234.567) -> hapus semua sebagai pemisah ribuan.
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
    // Satu pemisah yang bukan grup 3 digit (2.5, 12,75) -> anggap desimal.
    const sepCount = (s.match(/[.,]/g) || []).length;
    if (sepCount === 1) return Number(s.replace(',', '.'));
    // Lebih dari satu pemisah tapi tidak rapi grup 3 digit -> pemisah terakhir dianggap desimal, sisanya dibuang.
    const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (lastSep === -1) return Number(s);
    return Number(`${s.slice(0, lastSep).replace(/[.,]/g, '')}.${s.slice(lastSep + 1)}`);
  };
  const usedIdx = new Set();
  let harga = '', jumlah = '';
  const lastIdx = numbers.length - 1;
  const lastVal = parseNum(numbers[lastIdx][0]);
  if (lastVal >= 100) { harga = lastVal; usedIdx.add(lastIdx); }
  for (let i = 0; i < numbers.length; i++) {
    if (usedIdx.has(i)) continue;
    jumlah = parseNum(numbers[i][0]);
    usedIdx.add(i);
    break;
  }

  // "5kg" (tanpa spasi) tidak kena \b antara digit & huruf -> selipkan spasi dulu biar tetap kedeteksi.
  const lower = text.toLowerCase().replace(/(\d)([a-z])/gi, '$1 $2');
  let satuan = '';
  for (const s of SATUAN_DIKENAL_TEKS) {
    if (new RegExp(`\\b${s}\\b`, 'i').test(lower)) { satuan = s; break; }
  }

  let nama = text;
  numbers.forEach((m, i) => { if (usedIdx.has(i)) nama = nama.replace(m[0], ' '); });
  if (satuan) nama = nama.replace(new RegExp(`\\b${satuan}\\b`, 'i'), ' ');
  nama = nama.replace(/[|,;:@=-]+/g, ' ').replace(/\brp\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!nama) return null;

  return { namaBarang: nama, jumlah, satuan, harga };
}

// Baris yang jelas bukan barang — footer halaman umum di PDF/dokumen (URL, cap tanggal-jam, "Halaman 1/3")
// — dibuang duluan supaya tidak ikut ketebak jadi barang palsu.
function poBarisFooterSampah(line) {
  const l = line.trim();
  if (!l) return true;
  if (/https?:\/\/|www\.\S+/i.test(l)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/.test(l)) return true;
  if (/^(halaman\s*|page\s*)?\d+\s*\/\s*\d+$/i.test(l)) return true;
  return false;
}

/** Pecah blok teks bebas jadi baris-baris barang (dipakai untuk hasil ekstraksi PDF/Word/OCR foto). */
function poTeksKeBaris(text) {
  return text.split(/\r?\n/).filter(l => !poBarisFooterSampah(l)).map(poParseBarisTeks).filter(Boolean);
}

/** Ekstrak teks dari file PDF halaman per halaman lewat pdf.js, disusun ulang jadi baris berdasarkan posisi Y tiap potongan teks. */
async function poEkstrakTeksPdf(arrayBuffer) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const semuaBaris = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY = null, baris = '';
    content.items.forEach(item => {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        semuaBaris.push(baris.trim());
        baris = '';
      }
      baris += item.str + ' ';
      lastY = y;
    });
    if (baris.trim()) semuaBaris.push(baris.trim());
  }
  return semuaBaris.join('\n');
}

/** Ekstrak barang dari file Word (.docx) — coba baca tabel dulu (paling akurat), kalau tidak ada tabel baru pakai teks per baris. */
async function poEkstrakBarisDocx(arrayBuffer) {
  const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(htmlResult.value, 'text/html');
  const table = doc.querySelector('table');
  if (table) {
    const trs = Array.from(table.querySelectorAll('tr'));
    const cellRows = trs.map(tr => Array.from(tr.querySelectorAll('td,th')).map(td => td.textContent.trim()));
    if (trs.length > 0) {
      const found = poCariBarisHeader(cellRows);
      const dataTrs = found ? trs.slice(found.headerRowIdx + 1) : trs;
      const kolomMap = found ? found.kolomMap : {};
      const idxNama = found ? found.kolomMap.namaBarang : 0;
      const namaSppgTerdeteksi = poCariNamaSppg(cellRows, found ? found.headerRowIdx : -1);
      const rows = [];
      const tanggalSet = new Set();
      dataTrs.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td,th')).map(td => td.textContent.trim());
        const namaBarang = cells[idxNama] || '';
        if (!namaBarang) return;
        const tanggal = kolomMap.tanggal !== undefined ? parseTanggalIndonesia(cells[kolomMap.tanggal]) : '';
        if (tanggal) tanggalSet.add(tanggal);
        rows.push({
          namaBarang,
          jumlah: kolomMap.jumlah !== undefined ? cells[kolomMap.jumlah] || '' : (cells[1] || ''),
          satuan: kolomMap.satuan !== undefined ? cells[kolomMap.satuan] || '' : (cells[2] || ''),
          harga: kolomMap.harga !== undefined ? cells[kolomMap.harga] || '' : (cells[3] || ''),
          tanggal,
        });
      });
      // Kalau hasilnya mencurigakan (kolom kena salah), coba jalur teks bebas dulu sebelum menyerah total.
      if (rows.length > 0 && poHasilImportMasukAkal(rows)) {
        let tanggalTerdeteksi = '', tanggalInfo = '';
        if (tanggalSet.size === 1) {
          tanggalTerdeteksi = [...tanggalSet][0];
        } else if (tanggalSet.size > 1) {
          const sorted = [...tanggalSet].sort();
          tanggalInfo = `File ini mencakup ${tanggalSet.size} tanggal pengiriman berbeda (${formatDate(sorted[0])} – ${formatDate(sorted[sorted.length - 1])}), jadi Tanggal PO tidak diisi otomatis — mohon isi manual.`;
        }
        return { rows, tanggalTerdeteksi, tanggalInfo, namaSppgTerdeteksi };
      }
    }
  }
  const rawText = await mammoth.extractRawText({ arrayBuffer });
  return { rows: poTeksKeBaris(rawText.value), tanggalTerdeteksi: '', tanggalInfo: '', namaSppgTerdeteksi: '' };
}

/** OCR foto/scan (JPG/PNG) lewat Tesseract.js — paling lambat & paling tidak akurat dari semua jenis file yang didukung. */
async function poEkstrakTeksGambar(file, onProgress) {
  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: onProgress,
  });
  return data.text;
}

const EKSTENSI_EXCEL = ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'xlsb'];

/**
 * Banyak PO SPPG nyata punya blok judul/rencana menu di atas (nama SPPG, tanggal kirim, daftar menu harian)
 * SEBELUM tabel barang sungguhan mulai, dan sebagian malah menyebar tabel barangnya ke BEBERAPA SHEET
 * sekaligus (satu sheet per hari, mis. "Senin"/"Selasa"/... — atau bahkan beberapa tabel per sheet untuk
 * kelompok penerima berbeda, mis. "Menu Porsi Kecil"/"Menu Porsi Besar"). Jadi SEMUA sheet & SEMUA blok
 * tabel dalam tiap sheet dibaca (lihat poCariSemuaBlokHeader), bukan cuma sheet/tabel pertama.
 */
function poBacaBarisExcel(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  if (workbook.SheetNames.length === 0) throw new Error('File kosong atau tidak ada sheet-nya.');

  let namaSppgTerdeteksi = '';
  let semuaRows = [];
  let adaBlokTerbaca = false;

  workbook.SheetNames.forEach(sheetName => {
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    if (rawRows.length === 0) return;
    if (!namaSppgTerdeteksi) namaSppgTerdeteksi = poCariNamaSppg(rawRows, -1);

    poCariSemuaBlokHeader(rawRows).forEach(blok => {
      adaBlokTerbaca = true;
      for (let r = blok.headerRowIdx + 1; r < blok.dataEnd; r++) {
        const row = rawRows[r];
        const namaBarang = String(row[blok.kolomMap.namaBarang] || '').trim();
        if (!namaBarang) continue;
        const tanggal = blok.kolomMap.tanggal !== undefined
          ? parseTanggalIndonesia(row[blok.kolomMap.tanggal])
          : (blok.tanggalBlok || '');
        semuaRows.push({
          namaBarang,
          jumlah: blok.kolomMap.jumlah !== undefined ? row[blok.kolomMap.jumlah] : '',
          satuan: blok.kolomMap.satuan !== undefined ? String(row[blok.kolomMap.satuan] || '').trim() : '',
          harga: blok.kolomMap.harga !== undefined ? row[blok.kolomMap.harga] : '',
          tanggal,
        });
      }
    });
  });

  if (!adaBlokTerbaca) {
    throw new Error('Kolom "Nama Barang" tidak ditemukan di file ini.\n\nPastikan ada kolom dengan header seperti "Nama Barang", "Barang", "Bahan", atau "Deskripsi".');
  }

  // Baris "Total"/"Subtotal" (umum di PO yang punya beberapa sub-tabel per tanggal kirim) bukan barang.
  const rows = semuaRows.filter(r => r.namaBarang && !/^(grand\s*|sub)?total$/i.test(r.namaBarang));
  if (!poHasilImportMasukAkal(rows)) {
    throw new Error('Kolom yang terbaca sepertinya keliru (nama barang malah berisi satuan seperti "Kg"/"Pcs"). Susunan tabel di file ini tidak terbaca dengan benar — coba rapikan filenya atau isi manual.');
  }

  // Tanggal PO cuma diisi otomatis kalau isi filenya memang cuma satu tanggal yang jelas; kalau ada
  // beberapa (satu minggu penuh, mis.), itu bukan hal yang boleh ditebak sendiri — dikasih tahu ke
  // pengguna lewat tanggalInfo, dan handleImportPoExcel akan menawarkan bikin PO terpisah per tanggal.
  const tanggalSet = new Set(rows.map(r => r.tanggal).filter(Boolean));
  let tanggalTerdeteksi = '';
  let tanggalInfo = '';
  if (tanggalSet.size === 1) {
    tanggalTerdeteksi = [...tanggalSet][0];
  } else if (tanggalSet.size > 1) {
    const sorted = [...tanggalSet].sort();
    tanggalInfo = `File ini mencakup ${tanggalSet.size} tanggal pengiriman berbeda (${formatDate(sorted[0])} – ${formatDate(sorted[sorted.length - 1])}), jadi Tanggal PO tidak diisi otomatis — mohon isi manual.`;
  }
  return { rows, tanggalTerdeteksi, tanggalInfo, namaSppgTerdeteksi };
}

/** Baca file yang dipilih (Excel/CSV, PDF, Word, atau foto JPG/PNG) dan tambahkan tiap barisnya sebagai baris barang PO — dipakai selain input manual. */
async function handleImportPoExcel(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // supaya file yang sama bisa dipilih ulang lain waktu
  if (!file) return;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const btn = document.getElementById('btnImportPoExcel');
  const labelAsli = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Membaca file...'; }

  try {
    let rows;
    let tanggalTerdeteksi = '';
    let tanggalInfo = '';
    let namaSppgTerdeteksi = '';
    let butuhPeriksaManual = false;

    if (EKSTENSI_EXCEL.includes(ext)) {
      if (typeof XLSX === 'undefined') throw new Error('Pembaca Excel belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
      ({ rows, tanggalTerdeteksi, tanggalInfo, namaSppgTerdeteksi } = poBacaBarisExcel(await file.arrayBuffer()));
    } else if (ext === 'pdf') {
      if (typeof pdfjsLib === 'undefined') throw new Error('Pembaca PDF belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
      if (btn) btn.textContent = 'Membaca PDF...';
      rows = poTeksKeBaris(await poEkstrakTeksPdf(await file.arrayBuffer()));
      butuhPeriksaManual = true;
    } else if (ext === 'doc' || ext === 'docx') {
      if (typeof mammoth === 'undefined') throw new Error('Pembaca Word belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
      if (btn) btn.textContent = 'Membaca dokumen Word...';
      ({ rows, tanggalTerdeteksi, tanggalInfo, namaSppgTerdeteksi } = await poEkstrakBarisDocx(await file.arrayBuffer()));
      butuhPeriksaManual = true;
    } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
      if (typeof Tesseract === 'undefined') throw new Error('Pembaca gambar (OCR) belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
      const teks = await poEkstrakTeksGambar(file, (m) => {
        if (btn && m.status === 'recognizing text') btn.textContent = `Membaca gambar... ${Math.round((m.progress || 0) * 100)}%`;
      });
      rows = poTeksKeBaris(teks);
      butuhPeriksaManual = true;
    } else {
      throw new Error(`Jenis file ".${ext}" belum didukung. Coba file Excel/CSV, PDF, Word (.docx), atau foto (JPG/PNG).`);
    }

    if (!rows || rows.length === 0) {
      throw new Error('Tidak ada barang yang berhasil terbaca dari file ini. Coba file lain, atau isi manual.');
    }

    const { kelompok, tanpaTanggal } = poKelompokkanPerTanggal(rows);

    // File dengan >=2 tanggal PO berbeda (mis. PO satu minggu penuh) TIDAK dicampur jadi satu PO — tiap
    // tanggal dibuatkan PO-nya sendiri langsung ke database, supaya jumlah/harga/tanggal tiap PO tetap benar
    // dan tidak tertukar. Nama SPPG-nya diambil dari file (lihat poCariNamaSppg); kalau filenya sendiri
    // tidak menyebutkannya, ditanyakan langsung — bukan ditebak dari nama file atau sumber lain.
    let namaSppgUntukSplit = namaSppgTerdeteksi;
    if (kelompok.length >= 2 && !namaSppgUntukSplit) {
      const isian = prompt(`File ini berisi ${kelompok.length} tanggal PO berbeda, tapi nama SPPG tidak disebutkan secara eksplisit di dalam file. Isi nama SPPG tujuan untuk membuat ${kelompok.length} PO otomatis (kosongkan/Batal untuk isi manual satu-satu):`, '');
      if (isian && isian.trim()) namaSppgUntukSplit = isian.trim();
    }

    if (kelompok.length >= 2 && namaSppgUntukSplit) {
      const preview = kelompok.map(g => `- ${formatDate(g.tanggal)}: ${g.items.length} barang`).join('\n');
      const catatanTanpaTanggal = tanpaTanggal.length > 0
        ? `\n\n${tanpaTanggal.length} barang lain tidak punya tanggal pengiriman yang jelas — akan ditambahkan ke form ini untuk diisi manual, tidak ikut dibuatkan PO otomatis.`
        : '';
      const konfirmasi = `File ini berisi ${kelompok.length} tanggal PO berbeda untuk "${namaSppgUntukSplit}":\n${preview}${catatanTanpaTanggal}\n\nBuat ${kelompok.length} PO terpisah secara otomatis (status: Menunggu Pembelian)?`;
      if (!confirm(konfirmasi)) {
        alert('Impor dibatalkan. Tidak ada data yang ditambahkan.');
        return;
      }

      if (btn) btn.textContent = `Membuat ${kelompok.length} PO...`;
      await poBuatBanyakPoDariFile(kelompok, namaSppgUntukSplit, file.name);
      logActivity({
        action: 'tambah', modul: 'Koperasi - PO SPPG',
        ringkasan: `Impor otomatis ${kelompok.length} PO dari file untuk ${namaSppgUntukSplit} (${rows.length - tanpaTanggal.length} barang, ${formatDate(kelompok[0].tanggal)}–${formatDate(kelompok[kelompok.length - 1].tanggal)})`,
      });

      if (tanpaTanggal.length > 0) {
        tanpaTanggal.forEach(r => {
          addItemRow({
            namaBarang: r.namaBarang,
            jumlah: r.jumlah === '' || r.jumlah === undefined ? '' : Number(r.jumlah),
            satuan: r.satuan || '',
            hargaRencana: r.harga === '' || r.harga === undefined ? '' : Number(r.harga),
          });
        });
      }

      alert(`${kelompok.length} PO berhasil dibuat otomatis untuk "${namaSppgUntukSplit}" (${formatDate(kelompok[0].tanggal)}–${formatDate(kelompok[kelompok.length - 1].tanggal)}). Cek daftar PO di bawah — tetap periksa isinya sebelum diproses lebih lanjut.${tanpaTanggal.length > 0 ? `\n\n${tanpaTanggal.length} barang tanpa tanggal jelas sudah ditambahkan ke form ini — isi tanggal & SPPG manual lalu Simpan PO.` : ''}${butuhPeriksaManual ? '\n\nJenis file ini dibaca otomatis dari teks/gambar, jadi bisa saja ada yang salah baca.' : ''}`);
      return;
    }

    if (kelompok.length >= 2 && !namaSppgUntukSplit) {
      tanggalTerdeteksi = '';
      tanggalInfo = `File ini berisi ${kelompok.length} tanggal PO berbeda, tapi nama SPPG tidak diisi sehingga tidak bisa otomatis dibuat per-PO. Semua ${rows.length} barang dimasukkan ke satu form ini — mohon pisahkan & isi tanggal/SPPG manual sesuai kebutuhan.`;
    }

    rows.forEach(r => {
      addItemRow({
        namaBarang: r.namaBarang,
        jumlah: r.jumlah === '' || r.jumlah === undefined ? '' : Number(r.jumlah),
        satuan: r.satuan || '',
        hargaRencana: r.harga === '' || r.harga === undefined ? '' : Number(r.harga),
      });
    });

    // Baris kosong bawaan dari resetItemRows()/addItemRow() sebelumnya dibiarkan tetap ada supaya tidak
    // mengejutkan kalau field-nya sudah sempat diisi manual — cuma dirapikan kalau memang masih kosong total.
    const rowsEl = document.querySelectorAll('#poItemRows .nota-item-row');
    if (rowsEl.length > rows.length) {
      const first = rowsEl[0];
      if (!first.querySelector('.nir-nama').value.trim()) first.remove();
    }

    if (tanggalTerdeteksi) document.getElementById('poTanggal').value = tanggalTerdeteksi;
    if (namaSppgTerdeteksi) document.getElementById('poTujuan').value = namaSppgTerdeteksi;

    const catatanTambahan = [
      tanggalTerdeteksi ? 'Tanggal PO ikut disesuaikan otomatis dari isi file.' : '',
      namaSppgTerdeteksi ? `Tujuan/Nama SPPG ikut diisi otomatis dari file: "${namaSppgTerdeteksi}".` : '',
      tanggalInfo,
      butuhPeriksaManual ? 'Jenis file ini dibaca otomatis dari teks/gambar (bukan tabel Excel), jadi bisa saja ada yang salah baca — mohon PERIKSA ULANG tiap baris (nama, jumlah, satuan, harga) sebelum klik Simpan PO.' : '',
    ].filter(Boolean).join('\n');
    alert(`${rows.length} barang berhasil diimpor dari file.${catatanTambahan ? '\n\n' + catatanTambahan : ''}`);
  } catch (err) {
    console.error(err);
    alert(err.message || 'Gagal membaca file ini.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = labelAsli || '📄 Impor dari File'; }
  }
}

function readItemRows() {
  const rows = document.querySelectorAll('#poItemRows .nota-item-row');
  const items = [];
  rows.forEach(row => {
    const namaBarang = row.querySelector('.nir-nama').value.trim();
    const jumlah = row.querySelector('.nir-jumlah').value;
    const satuan = row.querySelector('.nir-satuan').value.trim();
    const harga = row.querySelector('.nir-harga').value;
    if (!namaBarang && !jumlah && !satuan && !harga) return; // baris kosong, lewati
    items.push({
      namaBarang,
      jumlah: jumlah === '' ? null : Number(jumlah),
      satuan,
      hargaRencana: harga === '' ? null : Number(harga),
      hargaFinal: null,
      itemId: row.dataset.itemid || genId(),
    });
  });
  return items;
}

export function watchPoSppg(onChange) {
  const logEl = document.getElementById('poSppgLog');
  logEl.innerHTML = `<div class="empty-state">Memuat data PO...</div>`;
  const q = query(collection(state.db, 'poSppg'), orderBy('createdAt', 'desc'), limit(300));
  if (state.poSppgUnsub) state.poSppgUnsub();
  state.poSppgUnsub = onSnapshot(q, (qs) => {
    state.lastPoSppgItems = [];
    qs.forEach(d => state.lastPoSppgItems.push({ id: d.id, ...d.data() }));
    renderPoSppg();
    if (onChange) onChange();
  }, (err) => {
    console.error(err);
    logEl.innerHTML = `<div class="empty-state">Gagal memuat data PO dari SPPG.</div>`;
  });
}

function filteredPo() {
  const dari = document.getElementById('poFilterDari').value;
  const sampai = document.getElementById('poFilterSampai').value;
  const status = document.getElementById('poFilterStatus').value;
  return state.lastPoSppgItems.filter(po => {
    if (status !== 'all' && po.status !== status) return false;
    if ((dari || sampai) && !isDateStrInRange(po.tanggalPo, dari, sampai)) return false;
    return true;
  });
}

/** Total nilai PO (harga satuan x jumlah per barang) — pakai harga final kalau sudah dikonfirmasi, kalau belum pakai harga rencana. */
function poTotal(po) {
  const items = po.items || [];
  const hasFinal = items.some(it => typeof it.hargaFinal === 'number');
  const total = items.reduce((sum, it) => {
    const h = hasFinal ? it.hargaFinal : it.hargaRencana;
    const jumlah = typeof it.jumlah === 'number' ? it.jumlah : 0;
    return sum + (typeof h === 'number' ? h * jumlah : 0);
  }, 0);
  return Math.round(total);
}

function itemSubtotal(it, useFinal) {
  const h = useFinal ? it.hargaFinal : it.hargaRencana;
  const jumlah = typeof it.jumlah === 'number' ? it.jumlah : 0;
  return typeof h === 'number' ? Math.round(h * jumlah) : null;
}

export function renderPoSppg() {
  const logEl = document.getElementById('poSppgLog');
  const list = filteredPo();

  const menungguTindakan = state.lastPoSppgItems.filter(po =>
    po.status === 'menunggu_pembelian' || po.status === 'menunggu_persetujuan' || po.status === 'disetujui'
  ).length;
  const aktif = state.lastPoSppgItems.filter(po => po.status !== 'terkirim' && po.status !== 'ditolak').length;
  const menungguEl = document.getElementById('poMenungguTindakan');
  const aktifEl = document.getElementById('poAktifCount');
  if (menungguEl) menungguEl.textContent = String(menungguTindakan);
  if (aktifEl) aktifEl.textContent = String(aktif);

  const importBar = document.getElementById('poImportBar');
  if (importBar) {
    const perluNota = isArsipImported() && arsipPerluNota();
    importBar.classList.toggle('hidden', isArsipImported() && !perluNota);
    const spanEl = importBar.querySelector('span');
    const btnEl = document.getElementById('btnImportArsipPo');
    if (spanEl && btnEl && !btnEl.disabled) {
      if (perluNota) {
        spanEl.textContent = '⚠️ Arsip LPJ Pengadaan Bahan Baku sudah masuk PO, tapi belum tercatat sebagai Total Pemasukan di Laporan Keuangan Koperasi.';
        btnEl.textContent = 'Lengkapi Data Pemasukan Arsip';
      } else {
        spanEl.textContent = '📦 Ada arsip LPJ Pengadaan Bahan Baku (April–Agustus 2026) dari dashboard keuangan koperasi — lengkap dengan data pembelian & biaya operasional, jadi margin/profit-nya langsung terhitung — yang belum dimasukkan ke sistem.';
        btnEl.textContent = 'Import Arsip Sekarang';
      }
    }
  }

  if (list.length === 0) {
    logEl.innerHTML = `<div class="empty-state">Belum ada PO dari SPPG untuk filter ini.</div>`;
    return;
  }

  logEl.innerHTML = list.map(po => renderCard(po)).join('');
  wireCardActions(logEl);
}

function isArsipImported() {
  return state.lastPoSppgItems.some(po => po.importBatch === MARGIN_LAMA_BATCH);
}

/** PO arsip yang statusnya sudah "terkirim" tapi belum ada nota Distribusi SPPG yang menyertai — jadi belum tercatat sebagai Total Pemasukan di Laporan Keuangan Koperasi. */
function arsipPerluNota() {
  return state.lastPoSppgItems.some(po => po.importBatch === MARGIN_LAMA_BATCH && !po.distribusiId);
}

/** Hapus arsip PO lama (batch sebelum ada data pembelian/margin) kalau pernah diimpor — digantikan arsip LPJ yang baru. */
async function hapusArsipPoLama() {
  const q = query(collection(state.db, 'poSppg'), where('importBatch', '==', OLD_PO_LAMA_BATCH));
  const snap = await getDocs(q);
  if (snap.empty) return 0;
  let batch = writeBatch(state.db);
  let opsInBatch = 0;
  let deleted = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    opsInBatch += 1; deleted += 1;
    if (opsInBatch >= 450) {
      await batch.commit();
      batch = writeBatch(state.db);
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();
  return deleted;
}

async function importArsipLama() {
  const perluNotaSaja = isArsipImported() && arsipPerluNota();
  const totalDocs = MARGIN_LAMA_DATA.reduce((s, rec) => s + 2 + rec.items.length + rec.biayaOperasional.length, 0);
  const confirmMsg = perluNotaSaja
    ? `Arsip LPJ sudah pernah diimpor, tapi belum tercatat sebagai Total Pemasukan di Laporan Keuangan Koperasi (belum ada nota Distribusi SPPG). Lengkapi sekarang?`
    : `Import arsip LPJ Pengadaan Bahan Baku (April–Agustus 2026): ${MARGIN_LAMA_DATA.length} PO lengkap dengan nota pemasukan, data pembelian & biaya operasional (total ${totalDocs} dokumen).\n\n` +
      `Arsip lama (tanpa data margin) akan dihapus otomatis dan digantikan arsip ini. Proses bisa makan waktu beberapa menit. Lanjutkan?`;
  if (!confirm(confirmMsg)) return;

  const existingKeys = new Set(
    state.lastPoSppgItems.filter(po => po.importBatch === MARGIN_LAMA_BATCH).map(po => `${po.tanggalPo}|${po.tujuanSppg}`)
  );
  const poTanpaNota = state.lastPoSppgItems.filter(po => po.importBatch === MARGIN_LAMA_BATCH && !po.distribusiId);

  const btn = document.getElementById('btnImportArsipPo');
  if (btn) { btn.disabled = true; btn.textContent = perluNotaSaja ? 'Melengkapi data pemasukan...' : 'Membersihkan arsip lama...'; }
  if (!perluNotaSaja) {
    try {
      await hapusArsipPoLama();
    } catch (e) {
      console.error('Gagal menghapus arsip PO lama', e);
    }
  }

  let batch = writeBatch(state.db);
  let opsInBatch = 0;
  let poCount = 0, pembelianCount = 0, biayaCount = 0, notaCount = 0;

  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    batch = writeBatch(state.db);
    opsInBatch = 0;
  };

  for (const rec of MARGIN_LAMA_DATA) {
    const key = `${rec.tanggal}|${rec.tujuanSppg}`;
    if (existingKeys.has(key)) continue;
    if (btn) btn.textContent = `Mengimpor... (${poCount}/${MARGIN_LAMA_DATA.length} PO)`;

    const poRef = doc(collection(state.db, 'poSppg'));
    const notaRef = doc(collection(state.db, 'distribusiSppg'));
    const items = rec.items.map((it, idx) => ({
      namaBarang: it.namaBarang,
      jumlah: it.jumlah,
      satuan: it.satuan,
      hargaRencana: it.hargaSatuan,
      hargaFinal: it.hargaSatuan,
      itemId: `${poRef.id}-i${idx}`,
    }));
    batch.set(poRef, {
      tanggalPo: rec.tanggal,
      tujuanSppg: rec.tujuanSppg,
      items,
      catatan: 'Arsip LPJ Pengadaan Bahan Baku (diimpor dari dashboard keuangan koperasi)',
      status: 'terkirim',
      distribusiId: notaRef.id,
      invoiceNomor: null,
      importBatch: MARGIN_LAMA_BATCH,
      createdAt: serverTimestamp(),
      createdBy: state.currentUserEmail,
    });
    opsInBatch += 1;
    poCount += 1;
    if (opsInBatch >= 450) await flush();

    batch.set(notaRef, {
      tanggalKirim: rec.tanggal,
      jamKirim: '',
      tujuanSppg: rec.tujuanSppg,
      catatan: 'Arsip LPJ Pengadaan Bahan Baku (diimpor dari dashboard keuangan koperasi)',
      items: rec.items.map(it => ({ namaBarang: it.namaBarang, jumlah: it.jumlah, satuan: it.satuan, hargaJual: it.hargaSatuan })),
      poId: poRef.id,
      importBatch: MARGIN_LAMA_BATCH,
      createdAt: serverTimestamp(),
      createdBy: state.currentUserEmail,
    });
    opsInBatch += 1;
    notaCount += 1;
    if (opsInBatch >= 450) await flush();

    for (let idx = 0; idx < rec.items.length; idx++) {
      const it = rec.items[idx];
      const pbRef = doc(collection(state.db, 'pembelianBahanMakanan'));
      batch.set(pbRef, {
        namaToko: '(Arsip LPJ)',
        noHpToko: '',
        alamatToko: '',
        namaPembeli: '(Arsip)',
        namaBarang: it.namaBarang,
        jumlah: it.jumlah,
        satuan: it.satuan,
        harga: it.realisasi ?? 0,
        catatan: 'Realisasi arsip LPJ',
        poId: poRef.id,
        poItemId: items[idx].itemId,
        createdAt: serverTimestamp(),
        createdBy: state.currentUserEmail,
        importBatch: MARGIN_LAMA_BATCH,
      });
      opsInBatch += 1;
      pembelianCount += 1;
      if (opsInBatch >= 450) await flush();
    }

    for (const o of rec.biayaOperasional) {
      const boRef = doc(collection(state.db, 'biayaOperasional'));
      batch.set(boRef, {
        tanggal: rec.tanggal,
        lokasi: rec.tujuanSppg,
        kategori: o.kategori,
        keterangan: o.keterangan,
        jumlah: o.jumlah,
        createdAt: serverTimestamp(),
        createdBy: state.currentUserEmail,
        importBatch: MARGIN_LAMA_BATCH,
      });
      opsInBatch += 1;
      biayaCount += 1;
      if (opsInBatch >= 450) await flush();
    }

    existingKeys.add(key);
  }

  // Arsip yang sudah lebih dulu diimpor (sebelum fitur nota-pemasukan ini ada) belum punya
  // nota Distribusi SPPG — lengkapi di sini pakai data yang sudah tersimpan di PO-nya sendiri.
  for (const po of poTanpaNota) {
    if (btn) btn.textContent = `Melengkapi data pemasukan... (${notaCount})`;
    const notaRef = doc(collection(state.db, 'distribusiSppg'));
    batch.set(notaRef, {
      tanggalKirim: po.tanggalPo,
      jamKirim: '',
      tujuanSppg: po.tujuanSppg,
      catatan: 'Arsip LPJ Pengadaan Bahan Baku (diimpor dari dashboard keuangan koperasi)',
      items: (po.items || []).map(it => ({ namaBarang: it.namaBarang, jumlah: it.jumlah, satuan: it.satuan, hargaJual: it.hargaFinal ?? it.hargaRencana })),
      poId: po.id,
      importBatch: MARGIN_LAMA_BATCH,
      createdAt: serverTimestamp(),
      createdBy: state.currentUserEmail,
    });
    opsInBatch += 1;
    notaCount += 1;
    if (opsInBatch >= 450) await flush();

    batch.update(doc(state.db, 'poSppg', po.id), { distribusiId: notaRef.id });
    opsInBatch += 1;
    if (opsInBatch >= 450) await flush();
  }

  await flush();

  if (poCount > 0 || notaCount > 0) {
    logActivity({
      action: 'tambah', modul: 'Koperasi - PO SPPG',
      ringkasan: poCount > 0
        ? `Import arsip LPJ: ${poCount} PO, ${notaCount} nota pemasukan, ${pembelianCount} pembelian, ${biayaCount} biaya operasional (April–Agustus 2026)`
        : `Lengkapi data pemasukan arsip LPJ: ${notaCount} nota Distribusi SPPG`,
    });
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Import Arsip Sekarang'; }
  alert(poCount > 0
    ? `Selesai. ${poCount} PO, ${notaCount} nota pemasukan, ${pembelianCount} pembelian, dan ${biayaCount} biaya operasional berhasil diimpor.`
    : `Selesai. ${notaCount} nota pemasukan berhasil dilengkapi — sekarang tercatat di Total Pemasukan.`);
}

/** Semua catatan Pembelian yang ditautkan ke barang PO tertentu (poId + itemId). */
function pembelianUntukPoItem(poId, itemId) {
  return (state.lastPembelianItems || []).filter(p => p.poId === poId && p.poItemId === itemId);
}

/** Realisasi pembelian (Rp total & qty) untuk satu barang PO — `harga` di Pembelian sudah berupa total per baris, bukan per satuan. */
function itemRealisasi(poId, itemId) {
  const purchases = pembelianUntukPoItem(poId, itemId);
  const totalRp = purchases.reduce((sum, p) => sum + (typeof p.harga === 'number' ? p.harga : 0), 0);
  const totalQty = purchases.reduce((sum, p) => sum + (typeof p.jumlah === 'number' ? p.jumlah : 0), 0);
  return { purchases, totalRp, totalQty };
}

/**
 * Total margin kotor (Harga Jual − Realisasi Beli) dari semua PO yang tanggalPo-nya
 * masuk rentang dari/sampai. Diekspor untuk dipakai Laporan Keuangan Koperasi
 * ("Total Profit Real" = margin kotor ini dikurangi Biaya Operasional).
 */
export function computeMarginKotor(dari, sampai) {
  const list = state.lastPoSppgItems.filter(po => isDateStrInRange(po.tanggalPo, dari, sampai));
  let total = 0;
  list.forEach(po => {
    const showFinal = po.status !== 'menunggu_pembelian';
    (po.items || []).forEach((it, idx) => {
      const hargaSatuan = showFinal ? it.hargaFinal : it.hargaRencana;
      if (typeof hargaSatuan !== 'number') return;
      const key = poItemKey(it, idx);
      const { totalRp: realisasi, totalQty: dibeli } = itemRealisasi(po.id, key);
      if (dibeli <= 0) return;
      total += (hargaSatuan * dibeli) - realisasi;
    });
  });
  return Math.round(total);
}

function renderCard(po) {
  const items = po.items || [];
  const showFinal = po.status !== 'menunggu_pembelian';
  const total = poTotal(po);
  let marginPoTotal = null;

  const itemsHtml = items.map((it, idx) => {
    const hargaSatuan = showFinal ? it.hargaFinal : it.hargaRencana;
    const subtotal = itemSubtotal(it, showFinal);
    const label = typeof hargaSatuan === 'number'
      ? `${formatRupiah(subtotal)}${!showFinal ? ' (rencana)' : ''}`
      : '-';
    const title = typeof hargaSatuan === 'number' ? `@ ${formatRupiah(hargaSatuan)} / ${escapeHtml(it.satuan || 'satuan')}` : '';

    const key = poItemKey(it, idx);
    const { purchases, totalRp: realisasi, totalQty: dibeli } = itemRealisasi(po.id, key);

    let progressHtml = '';
    if (purchases.length > 0) {
      const jumlahOrder = typeof it.jumlah === 'number' ? it.jumlah : 0;
      const sisa = jumlahOrder - dibeli;
      const perToko = purchases.map(p => `${escapeHtml(p.namaToko || '-')}: ${p.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}`).join(', ');
      const purchaseLine = po.status === 'menunggu_pembelian'
        ? `${sisa <= 0 ? '✓' : '↻'} ${dibeli} ${escapeHtml(it.satuan || '')} sudah dibeli (${perToko})${sisa > 0 ? ` · sisa ${sisa} ${escapeHtml(it.satuan || '')}` : ' · terpenuhi'}`
        : `Dibeli dari: ${perToko}`;

      let marginHtml = '';
      if (typeof hargaSatuan === 'number' && dibeli > 0) {
        const hargaBeliSatuan = Math.round(realisasi / dibeli);
        const revenueSoFar = hargaSatuan * dibeli;
        const marginPo = revenueSoFar - realisasi;
        const marginSatuan = hargaSatuan - hargaBeliSatuan;
        marginPoTotal = (marginPoTotal ?? 0) + marginPo;
        const cls = marginPo >= 0 ? 'po-margin-line--positive' : 'po-margin-line--negative';
        marginHtml = `<div class="po-margin-line ${cls}">💰 Margin: ${formatRupiah(marginPo)} (${formatRupiah(marginSatuan)}/${escapeHtml(it.satuan || 'satuan')})${sisa > 0 ? ' · sementara' : ''}</div>`;
      }

      progressHtml = `
          <div class="po-purchase-progress${sisa <= 0 && po.status === 'menunggu_pembelian' ? ' po-purchase-progress--done' : ''}">${purchaseLine} · Realisasi ${formatRupiah(realisasi)}</div>
          ${marginHtml}`;
    }

    return `
    <div class="nota-detail-row">
      <span class="nota-detail-nama">${escapeHtml(it.namaBarang)}</span>
      <span class="nota-detail-qty">${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
      <span class="nota-detail-harga" title="${title}">${label}</span>
    </div>
    ${progressHtml}
  `;
  }).join('');

  return `
    <div class="po-card" data-poid="${po.id}">
      <div class="po-card-head">
        <div>
          <b>${escapeHtml(po.tujuanSppg)}</b>
          <div class="meta">PO: ${formatDate(po.tanggalPo)} · ${items.length} jenis barang${po.catatan ? ' · ' + escapeHtml(po.catatan) : ''}</div>
          <div class="meta">Dicatat ${formatTimestamp(po.createdAt)}${po.createdBy ? ' · oleh ' + escapeHtml(po.createdBy) : ''}</div>
          ${po.status === 'terkirim' ? `<div class="meta">Nota pengiriman sudah dibuat${po.invoiceNomor ? ' · Invoice ' + escapeHtml(po.invoiceNomor) : ''}</div>` : ''}
        </div>
        <span class="po-status-badge po-status-badge--${po.status}">${STATUS_LABEL[po.status] || po.status}</span>
      </div>
      <div class="po-card-items">${itemsHtml}</div>
      ${total > 0 ? `<div class="po-card-total">Total: ${formatRupiah(total)}</div>` : ''}
      ${marginPoTotal !== null ? `<div class="po-card-total po-card-total--margin ${marginPoTotal >= 0 ? 'po-margin-line--positive' : 'po-margin-line--negative'}">💰 Margin PO: ${formatRupiah(marginPoTotal)}</div>` : ''}
      ${renderInlineForm(po)}
      <div class="po-card-actions">${renderActions(po)}</div>
    </div>
  `;
}

function renderInlineForm(po) {
  if (po.status === 'menunggu_pembelian' && confirmExpandId === po.id) {
    const rows = (po.items || []).map((it, idx) => `
      <div class="po-inline-row">
        <span>${escapeHtml(it.namaBarang)}</span>
        <span>${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</span>
        <input type="number" class="po-confirm-harga" data-idx="${idx}" placeholder="Harga satuan final" value="${it.hargaRencana ?? ''}">
      </div>
    `).join('');
    return `
      <div class="po-inline-form" data-form="confirm">
        <h4>Isi harga satuan final per barang (hasil belanja), lalu kirim ke SPPG:</h4>
        ${rows}
        <div class="po-inline-form-actions">
          <button type="button" class="btn-ghost" data-po-cancel-confirm="${po.id}">Batal</button>
          <button type="button" class="btn" data-po-submit-confirm="${po.id}">Simpan &amp; Kirim ke SPPG</button>
        </div>
      </div>`;
  }
  if (po.status === 'terkirim' && invoiceExpandId === po.id) {
    return `
      <div class="po-inline-form" data-form="invoice">
        <h4>Detail sebelum cetak Invoice/Berita Acara:</h4>
        <div class="po-invoice-fields">
          <label>Potongan (%)<input type="number" step="0.1" id="poInvoicePotongan-${po.id}" value="${po.invoicePotongan ?? 0}"></label>
          <label>PPN (%)<input type="number" step="0.1" id="poInvoicePpn-${po.id}" value="${po.invoicePpn ?? 0}"></label>
        </div>
        <div class="po-inline-form-actions">
          <button type="button" class="btn-ghost" data-po-cancel-invoice="${po.id}">Batal</button>
          <button type="button" class="btn" data-po-submit-invoice="${po.id}">${po.invoiceNomor ? 'Cetak Ulang Invoice' : 'Cetak Invoice'}</button>
        </div>
      </div>`;
  }
  return '';
}

function renderActions(po) {
  const actions = [];
  if (po.status === 'menunggu_pembelian') {
    actions.push(`<button type="button" class="edit-btn" data-po-edit="${po.id}" title="Edit PO">✏️</button>`);
    if (confirmExpandId !== po.id) {
      actions.push(`<button type="button" class="btn" data-po-confirm="${po.id}">Konfirmasi Harga ke SPPG</button>`);
    }
  } else if (po.status === 'menunggu_persetujuan') {
    actions.push(`<button type="button" class="btn-ghost" data-po-print-konfirmasi="${po.id}">Cetak Konfirmasi Harga (PDF)</button>`);
    actions.push(`<button type="button" class="btn-ghost" data-po-reject="${po.id}">SPPG Menolak</button>`);
    actions.push(`<button type="button" class="btn" data-po-approve="${po.id}">SPPG Setuju</button>`);
  } else if (po.status === 'disetujui') {
    actions.push(`<button type="button" class="btn-ghost" data-po-print-persetujuan="${po.id}">Cetak Persetujuan Harga (PDF)</button>`);
    actions.push(`<button type="button" class="btn" data-po-buat-nota="${po.id}">Buat Nota Pengiriman →</button>`);
  } else if (po.status === 'terkirim') {
    if (invoiceExpandId !== po.id) {
      actions.push(`<button type="button" class="btn" data-po-invoice="${po.id}">${po.invoiceNomor ? 'Cetak Ulang Invoice' : 'Cetak Invoice / Berita Acara'}</button>`);
    }
  }
  actions.push(`<button type="button" class="btn-danger" data-po-delete="${po.id}" title="Hapus PO ini">🗑 Hapus</button>`);
  return actions.join('');
}

function wireCardActions(root) {
  root.querySelectorAll('[data-po-edit]').forEach(btn => btn.addEventListener('click', () => {
    const po = state.lastPoSppgItems.find(p => p.id === btn.dataset.poEdit);
    if (po) startEditPo(po);
  }));
  root.querySelectorAll('[data-po-confirm]').forEach(btn => btn.addEventListener('click', () => {
    confirmExpandId = btn.dataset.poConfirm;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-cancel-confirm]').forEach(btn => btn.addEventListener('click', () => {
    confirmExpandId = null;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-submit-confirm]').forEach(btn => btn.addEventListener('click', () => submitConfirmHarga(btn.dataset.poSubmitConfirm)));
  root.querySelectorAll('[data-po-approve]').forEach(btn => btn.addEventListener('click', () => setStatus(btn.dataset.poApprove, 'disetujui')));
  root.querySelectorAll('[data-po-reject]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('Tandai PO ini ditolak oleh SPPG?')) return;
    setStatus(btn.dataset.poReject, 'ditolak');
  }));
  root.querySelectorAll('[data-po-buat-nota]').forEach(btn => btn.addEventListener('click', () => buatNotaDariPo(btn.dataset.poBuatNota)));
  root.querySelectorAll('[data-po-invoice]').forEach(btn => btn.addEventListener('click', () => {
    invoiceExpandId = btn.dataset.poInvoice;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-cancel-invoice]').forEach(btn => btn.addEventListener('click', () => {
    invoiceExpandId = null;
    renderPoSppg();
  }));
  root.querySelectorAll('[data-po-submit-invoice]').forEach(btn => btn.addEventListener('click', () => cetakInvoice(btn.dataset.poSubmitInvoice)));
  root.querySelectorAll('[data-po-print-konfirmasi]').forEach(btn => btn.addEventListener('click', () => cetakKonfirmasiHarga(btn.dataset.poPrintKonfirmasi)));
  root.querySelectorAll('[data-po-print-persetujuan]').forEach(btn => btn.addEventListener('click', () => cetakPersetujuanHarga(btn.dataset.poPrintPersetujuan)));
  root.querySelectorAll('[data-po-delete]').forEach(btn => btn.addEventListener('click', () => deletePo(btn.dataset.poDelete)));
}

async function submitConfirmHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = (po.items || []).map((it, idx) => {
    const input = document.querySelector(`.po-confirm-harga[data-idx="${idx}"]`);
    const val = input ? input.value : '';
    return { ...it, hargaFinal: val === '' ? null : Number(val) };
  });
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      items, status: 'menunggu_persetujuan', updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Konfirmasi harga PO ${po.tujuanSppg}, dikirim untuk persetujuan SPPG` });
    confirmExpandId = null;
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan konfirmasi harga. Pastikan Anda sudah login.');
  }
}

async function setStatus(poId, status) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), { status, updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail });
    logActivity({
      action: 'ubah', modul: 'Koperasi - PO SPPG',
      ringkasan: `PO ${po.tujuanSppg} ${status === 'disetujui' ? 'disetujui SPPG' : 'ditolak SPPG'}`,
    });
  } catch (e) {
    console.error(e);
    alert('Gagal mengubah status PO. Pastikan Anda sudah login.');
  }
}

function buatNotaDariPo(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  state.poPrefill = po;
  navigateTo('koperasi', 'distribusisppg');
}

/** Dipanggil dari ui-distribusi-sppg.js setelah nota pengiriman yang ditautkan ke PO ini berhasil disimpan. */
export async function markPoTerkirim(poId, distribusiId) {
  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      status: 'terkirim', distribusiId, updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
  } catch (e) {
    console.error('Gagal menandai PO sebagai terkirim', e);
  }
}

function nextInvoiceNomor(year) {
  const prefix = `INV/${year}/`;
  let max = 0;
  state.lastPoSppgItems.forEach(po => {
    if (po.invoiceNomor && po.invoiceNomor.startsWith(prefix)) {
      const n = parseInt(po.invoiceNomor.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

async function cetakInvoice(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const potonganInput = document.getElementById(`poInvoicePotongan-${poId}`);
  const ppnInput = document.getElementById(`poInvoicePpn-${poId}`);
  const potongan = potonganInput ? Number(potonganInput.value || 0) : (po.invoicePotongan || 0);
  const ppn = ppnInput ? Number(ppnInput.value || 0) : (po.invoicePpn || 0);
  const tanggalInvoice = po.invoiceTanggal || todayIso();
  const nomor = po.invoiceNomor || nextInvoiceNomor(tanggalInvoice.slice(0, 4));

  try {
    await updateDoc(doc(state.db, 'poSppg', poId), {
      invoiceNomor: nomor, invoiceTanggal: tanggalInvoice, invoicePotongan: potongan, invoicePpn: ppn,
      updatedAt: serverTimestamp(), updatedBy: state.currentUserEmail,
    });
    if (!po.invoiceNomor) {
      logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Cetak Invoice ${nomor} untuk PO ${po.tujuanSppg}` });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan nomor invoice. Cetak dibatalkan.');
    return;
  }

  printInvoiceBody({ ...po, invoiceNomor: nomor, invoiceTanggal: tanggalInvoice, invoicePotongan: potongan, invoicePpn: ppn });
  invoiceExpandId = null;
}

function cetakKonfirmasiHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = po.items || [];
  let totalRencana = 0, totalFinal = 0;
  const rows = items.map((it, i) => {
    const subRencana = itemSubtotal(it, false);
    const subFinal = itemSubtotal(it, true);
    if (typeof subRencana === 'number') totalRencana += subRencana;
    if (typeof subFinal === 'number') totalFinal += subFinal;
    const selisih = (typeof subFinal === 'number' && typeof subRencana === 'number') ? subFinal - subRencana : null;
    const selisihLabel = typeof selisih === 'number' ? (selisih === 0 ? 'Sama' : (selisih > 0 ? '+' : '−') + formatRupiah(Math.abs(selisih)).replace('Rp ', '')) : '-';
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(it.namaBarang)}</td>
        <td>${it.jumlah ?? '-'} ${escapeHtml(it.satuan || '')}</td>
        <td style="text-align:right">${typeof subRencana === 'number' ? formatRupiah(subRencana).replace('Rp ', '') : '-'}</td>
        <td style="text-align:right">${typeof subFinal === 'number' ? formatRupiah(subFinal).replace('Rp ', '') : '-'}</td>
        <td style="text-align:right">${selisihLabel}</td>
      </tr>`;
  }).join('');
  const selisihTotal = totalFinal - totalRencana;

  const body = `
    <div class="doc-accent-blue">
      <div class="invoice-head">
        ${invoiceHeadCompanyHtml()}
        <div class="invoice-title">KONFIRMASI HARGA</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">Untuk: <b>${escapeHtml(po.tujuanSppg)}</b><div style="font-size:10.5px;color:#555;margin-top:3px;">Mohon ditinjau &amp; disetujui sebelum barang dikirim.</div></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Tanggal PO:</span> ${formatDate(po.tanggalPo)}</div>
          <div class="row"><span class="lbl">Dicetak:</span> ${formatDate(todayIso())}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>No</th><th>Nama Barang</th><th>Qty</th><th>Subtotal Rencana</th><th>Subtotal Final</th><th>Selisih</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="invoice-bottom-row">
        <div class="invoice-pay-box">
          <div class="title">Catatan</div>
          <div>Harga final adalah hasil belanja aktual ke supplier, sehingga bisa berbeda dari harga rencana di awal PO.</div>
        </div>
        <div class="invoice-total-box">
          <div class="row"><span>Total Rencana</span><span>${formatRupiah(totalRencana)}</span></div>
          <div class="row"><span>Total Final</span><span>${formatRupiah(totalFinal)}</span></div>
          <div class="row total"><span>Selisih</span><span>${selisihTotal >= 0 ? '+' : '−'}${formatRupiah(Math.abs(selisihTotal))}</span></div>
        </div>
      </div>
      <div class="invoice-signature-2col">
        <div>
          <div>Disiapkan oleh,</div>
          <div class="sig-space"></div>
          <div class="sig-name">${escapeHtml(KOPERASI_INFO.penandaTangan)}</div>
          <div>${escapeHtml(KOPERASI_INFO.nama)}</div>
        </div>
        <div class="right">
          <div>Diperiksa &amp; disetujui oleh,</div>
          <div class="sig-space"></div>
          <div class="sig-name">&nbsp;</div>
          <div>${escapeHtml(po.tujuanSppg)}</div>
        </div>
      </div>
    </div>
  `;
  printReport(body, `Konfirmasi-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.tanggalPo)}`);
}

function cetakPersetujuanHarga(poId) {
  const po = state.lastPoSppgItems.find(p => p.id === poId);
  if (!po) return;
  const items = po.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(it.namaBarang)}</td>
      <td>${it.jumlah ?? '-'}</td>
      <td>${escapeHtml(it.satuan || '')}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' ? formatRupiah(it.hargaFinal).replace('Rp ', '') : '-'}</td>
      <td style="text-align:right">${typeof itemSubtotal(it, true) === 'number' ? formatRupiah(itemSubtotal(it, true)).replace('Rp ', '') : '-'}</td>
    </tr>`).join('');
  const total = poTotal(po);

  const body = `
    <div class="doc-accent-blue">
      <div class="invoice-head">
        ${invoiceHeadCompanyHtml()}
        <div class="invoice-title">PERSETUJUAN HARGA</div>
      </div>
      <div class="invoice-to-row">
        <div class="to">Untuk: <b>${escapeHtml(po.tujuanSppg)}</b><div style="font-size:10.5px;color:#2F8F4E;font-weight:700;margin-top:3px;">✓ Harga sudah disetujui SPPG — siap dikirim.</div></div>
        <div class="meta-right">
          <div class="row"><span class="lbl">Tanggal PO:</span> ${formatDate(po.tanggalPo)}</div>
          <div class="row"><span class="lbl">Dicetak:</span> ${formatDate(todayIso())}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>No</th><th>Nama Barang</th><th>Qty</th><th>Satuan</th><th>Harga Satuan</th><th>Nominal</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="invoice-bottom-row">
        <div class="invoice-pay-box">
          <div class="title">Catatan</div>
          <div>Dokumen ini menandakan harga sudah disepakati. Invoice resmi akan dicetak setelah barang dikirim.</div>
        </div>
        <div class="invoice-total-box">
          <div class="row total"><span>Total Disetujui</span><span>${formatRupiah(total)}</span></div>
        </div>
      </div>
    </div>
  `;
  printReport(body, `Persetujuan-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.tanggalPo)}`);
}

function printInvoiceBody(po) {
  const items = po.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${formatDate(po.tanggalPo)}</td>
      <td>${escapeHtml(it.namaBarang)}</td>
      <td>${it.jumlah ?? '-'}</td>
      <td>${escapeHtml(it.satuan || '')}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' ? formatRupiah(it.hargaFinal).replace('Rp ', '') : '-'}</td>
      <td style="text-align:right">${typeof it.hargaFinal === 'number' && it.jumlah ? formatRupiah(it.hargaFinal * it.jumlah).replace('Rp ', '') : '-'}</td>
    </tr>
  `).join('');

  const subtotal = poTotal(po);
  const setelahPotongan = Math.round(subtotal * (1 - (po.invoicePotongan || 0) / 100));
  const total = Math.round(setelahPotongan * (1 + (po.invoicePpn || 0) / 100));

  const body = `
    <div class="invoice-head">
      ${invoiceHeadCompanyHtml()}
      <div class="invoice-title">INVOICE</div>
    </div>
    <div class="invoice-to-row">
      <div class="to">To: <b>${escapeHtml(po.tujuanSppg)}</b></div>
      <div class="meta-right">
        <div class="row"><span class="lbl">Tanggal:</span> ${formatDate(po.invoiceTanggal)}</div>
        <div class="row"><span class="lbl">Nomor:</span> ${escapeHtml(po.invoiceNomor)}</div>
      </div>
    </div>
    <table class="invoice-table">
      <thead><tr><th>No</th><th>Tanggal</th><th>Nama Barang</th><th>Qty</th><th>Satuan</th><th>Harga Satuan</th><th>Nominal</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="invoice-bottom-row">
      <div class="invoice-pay-box">
        <div class="title">Please to be paid to our account as below:</div>
        <div class="pay-row"><span>Name of Bank</span><span>: <b>${escapeHtml(KOPERASI_INFO.bankNama)}</b></span></div>
        <div class="pay-row"><span>Account No.</span><span>: ${escapeHtml(KOPERASI_INFO.bankRekening)}</span></div>
        <div class="pay-row"><span></span><span>: ${escapeHtml(KOPERASI_INFO.bankAtasNama)}</span></div>
      </div>
      <div class="invoice-total-box">
        <div class="row"><span>Subtotal</span><span>${formatRupiah(subtotal)}</span></div>
        <div class="row"><span>Potongan${po.invoicePotongan ? ' (' + po.invoicePotongan + '%)' : ''}</span><span>${po.invoicePotongan ? '-' + formatRupiah(subtotal - setelahPotongan) : '-'}</span></div>
        <div class="row"><span>PPN${po.invoicePpn ? ' (' + po.invoicePpn + '%)' : ''}</span><span>${po.invoicePpn ? formatRupiah(total - setelahPotongan) : '-'}</span></div>
        <div class="row total"><span>Total</span><span>${formatRupiah(total)}</span></div>
      </div>
    </div>
    <div class="invoice-signature">
      <div>Your Sincerely,<br>${escapeHtml(KOPERASI_INFO.namaSingkat)}</div>
      <div class="sig-visual">
        <img class="sig-stempel" src="${STEMPEL_URL}" alt="">
        <img class="sig-ttd" src="${TTD_URL}" alt="">
      </div>
      <div class="sig-name">${escapeHtml(KOPERASI_INFO.penandaTangan)}</div>
    </div>
    <div class="invoice-bottom-rule"></div>
  `;
  printReport(body, `Invoice-${slugifyTujuan(po.tujuanSppg)}-${fileDateTag(po.invoiceTanggal)}`);
}

async function deletePo(id) {
  if (!id) return;
  if (!confirm('Hapus PO ini beserta seluruh barang di dalamnya? Tindakan ini tidak bisa dibatalkan.')) return;
  const po = state.lastPoSppgItems.find(p => p.id === id);
  try {
    await deleteDoc(doc(state.db, 'poSppg', id));
    if (po) {
      logActivity({
        action: 'hapus', modul: 'Koperasi - PO SPPG',
        ringkasan: `Hapus PO dari ${po.tujuanSppg} (${(po.items || []).length} jenis barang, status: ${STATUS_LABEL[po.status] || po.status})`,
      });
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menghapus. Pastikan Anda sudah login dan aturan Firestore mengizinkan hapus.');
  }
}

function startEditPo(po) {
  editingId = po.id;
  document.getElementById('poTanggal').value = po.tanggalPo || '';
  document.getElementById('poTujuan').value = po.tujuanSppg || '';
  document.getElementById('poCatatan').value = po.catatan || '';

  document.getElementById('poItemRows').innerHTML = '';
  rowCounter = 0;
  const items = po.items || [];
  if (items.length === 0) addItemRow(); else items.forEach(item => addItemRow(item));

  document.getElementById('btnSavePo').textContent = 'Update PO';
  document.getElementById('btnCancelEditPo').classList.remove('hidden');
  document.getElementById('poTujuan').closest('.dist-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditPo() {
  editingId = null;
  document.getElementById('poTujuan').value = '';
  document.getElementById('poCatatan').value = '';
  resetItemRows();
  document.getElementById('btnSavePo').textContent = 'Simpan PO';
  document.getElementById('btnCancelEditPo').classList.add('hidden');
}

export async function savePo() {
  const tanggalPo = document.getElementById('poTanggal').value;
  const tujuanSppg = document.getElementById('poTujuan').value.trim();
  const catatan = document.getElementById('poCatatan').value.trim();
  const items = readItemRows();

  if (!tanggalPo || !tujuanSppg) {
    alert('Mohon isi tanggal PO dan tujuan/nama SPPG.');
    return;
  }
  if (items.length === 0 || items.some(it => !it.namaBarang || !it.jumlah || !it.satuan)) {
    alert('Mohon isi nama barang, jumlah, dan satuan untuk setiap baris barang.');
    return;
  }

  const isEdit = !!editingId;
  const entry = { tanggalPo, tujuanSppg, catatan, items };
  if (isEdit) {
    entry.updatedAt = serverTimestamp();
    entry.updatedBy = state.currentUserEmail;
  } else {
    entry.status = 'menunggu_pembelian';
    entry.distribusiId = null;
    entry.invoiceNomor = null;
    entry.createdAt = serverTimestamp();
    entry.createdBy = state.currentUserEmail;
  }

  const btn = document.getElementById('btnSavePo');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (isEdit) {
      await updateDoc(doc(state.db, 'poSppg', editingId), entry);
      logActivity({ action: 'ubah', modul: 'Koperasi - PO SPPG', ringkasan: `Update PO dari ${tujuanSppg} (${items.length} jenis barang)` });
      cancelEditPo();
    } else {
      await addDoc(collection(state.db, 'poSppg'), entry);
      logActivity({ action: 'tambah', modul: 'Koperasi - PO SPPG', ringkasan: `PO baru dari ${tujuanSppg} (${items.length} jenis barang)` });
      document.getElementById('poTujuan').value = '';
      document.getElementById('poCatatan').value = '';
      resetItemRows();
    }
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan PO. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = editingId ? 'Update PO' : 'Simpan PO';
  }
}

export function downloadLaporanPo() {
  const dari = document.getElementById('poFilterDari').value;
  const sampai = document.getElementById('poFilterSampai').value;
  const list = filteredPo();

  if (list.length === 0) {
    alert('Tidak ada data PO untuk filter ini.');
    return;
  }

  const headers = ['Tanggal PO', 'Tujuan SPPG', 'Status', 'Nama Barang', 'Jumlah', 'Satuan', 'Harga Satuan Rencana (Rp)', 'Harga Satuan Final (Rp)', 'Subtotal (Rp)', 'Catatan', 'Nomor Invoice', 'Diinput Oleh'];
  const rows = [];
  list.forEach(po => {
    (po.items || []).forEach(item => {
      const subtotal = itemSubtotal(item, typeof item.hargaFinal === 'number');
      rows.push([
        formatDate(po.tanggalPo), po.tujuanSppg, STATUS_LABEL[po.status] || po.status,
        item.namaBarang, item.jumlah ?? '', item.satuan || '', item.hargaRencana ?? '', item.hargaFinal ?? '', subtotal ?? '',
        po.catatan || '', po.invoiceNomor || '', po.createdBy || '',
      ]);
    });
  });

  downloadCsv(`Laporan-PO-SPPG-${dateRangeFileTag(dari, sampai)}.csv`, headers, rows);
}

export function initPoSppgEvents() {
  document.getElementById('btnSavePo').addEventListener('click', savePo);
  document.getElementById('btnTambahBarangPo').addEventListener('click', addItemRow);
  document.getElementById('btnImportPoExcel').addEventListener('click', () => document.getElementById('inputImportPoExcel').click());
  document.getElementById('inputImportPoExcel').addEventListener('change', handleImportPoExcel);
  document.getElementById('btnCancelEditPo').addEventListener('click', cancelEditPo);
  const { dari, sampai } = monthRange();
  document.getElementById('poFilterDari').value = dari;
  document.getElementById('poFilterSampai').value = sampai;
  ['poFilterStatus', 'poFilterDari', 'poFilterSampai'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderPoSppg);
  });
  document.getElementById('btnPoFilterReset').addEventListener('click', () => {
    document.getElementById('poFilterStatus').value = 'all';
    document.getElementById('poFilterDari').value = '';
    document.getElementById('poFilterSampai').value = '';
    renderPoSppg();
  });
  document.getElementById('btnDownloadPo').addEventListener('click', downloadLaporanPo);
  document.getElementById('btnImportArsipPo').addEventListener('click', importArsipLama);
  resetItemRows();
}
