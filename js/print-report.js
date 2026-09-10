// ---------- Cetak laporan jadi PDF — pakai "Print > Save as PDF" bawaan browser ----------
// Tanpa library eksternal: konten laporan dirender ke satu area khusus (#printRoot)
// yang cuma tampil saat mode cetak (lihat style.css @media print), lalu window.print()
// dipanggil supaya user tinggal pilih tujuan "Save as PDF" di dialog cetak browser.
// simpanSebagaiGambar() di bawah pakai area & HTML yang sama, tapi merendernya jadi PNG
// lewat html2canvas — alternatif buat yang lebih suka kirim gambar (mis. lewat WhatsApp).

/** Tunggu semua gambar (logo/stempel/tanda tangan) di dalam elemen selesai dimuat — berhasil atau gagal —
 * supaya tidak ikut kepotong kosong saat dicetak/di-screenshot. */
function tungguGambar(root) {
  const pending = Array.from(root.querySelectorAll('img')).filter(img => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise(resolve => {
    let remaining = pending.length;
    const done = () => { remaining -= 1; if (remaining <= 0) resolve(); };
    pending.forEach(img => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  });
}

/**
 * @param {string} bodyHtml
 * @param {string} [filename] - kalau diisi, dipakai sebagai document.title sesaat sebelum
 *   window.print() dipanggil, supaya browser menyarankan nama file itu di dialog "Save as PDF".
 */
export function printReport(bodyHtml, filename) {
  let root = document.getElementById('printRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'printRoot';
    document.body.appendChild(root);
  }
  root.innerHTML = `<div class="print-report">${bodyHtml}</div>`;

  const originalTitle = document.title;
  const doPrint = () => {
    if (filename) document.title = filename;
    window.print();
    // window.print() sudah selesai begitu dialog cetak browser ditutup, tapi
    // printer virtual seperti "Microsoft Print to PDF" baru memunculkan dialog
    // "Save As" miliknya SETELAH itu — judul halaman ditunda dulu supaya nama
    // file masih sempat terbaca oleh dialog itu.
    if (filename) setTimeout(() => { document.title = originalTitle; }, 3000);
  };
  tungguGambar(root).then(doPrint);
}

/**
 * Simpan dokumen (Invoice/Surat Jalan/Konfirmasi/Persetujuan Harga — HTML yang sama dipakai printReport())
 * sebagai file gambar PNG, dengan merender tampilan cetaknya lewat html2canvas. Selama proses ini #printRoot
 * ditampilkan sesaat lewat INLINE STYLE (bukan class CSS) — html2canvas cuma bisa menangkap apa yang benar-
 * benar dirender di layar, dan proses cloning dokumen internalnya ternyata tidak selalu ikut menerapkan
 * perubahan visibilitas yang dipicu lewat class CSS (sempat diuji: canvas hasilnya 0×0 kalau pakai class,
 * padahal elemennya sudah benar terlihat & punya ukuran saat dicek langsung) — inline style terbukti aman.
 * @param {string} bodyHtml
 * @param {string} [filename] - nama file .png yang diunduh (tanpa ekstensi, ditambahkan otomatis).
 */
export async function simpanSebagaiGambar(bodyHtml, filename) {
  if (typeof html2canvas === 'undefined') {
    alert('Fitur simpan gambar belum siap dimuat. Pastikan koneksi internet aktif, muat ulang halaman, lalu coba lagi.');
    return;
  }
  let root = document.getElementById('printRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'printRoot';
    document.body.appendChild(root);
  }
  root.innerHTML = `<div class="print-report">${bodyHtml}</div>`;
  await tungguGambar(root);

  root.style.setProperty('display', 'block', 'important');
  try {
    const target = root.querySelector('.print-report');
    const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff' });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob() gagal');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename || 'dokumen'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan sebagai gambar. Coba lagi, atau pakai tombol Cetak (PDF) sebagai alternatif.');
  } finally {
    root.style.removeProperty('display');
  }
}
