// ---------- Cetak laporan jadi PDF — pakai "Print > Save as PDF" bawaan browser ----------
// Tanpa library eksternal: konten laporan dirender ke satu area khusus (#printRoot)
// yang cuma tampil saat mode cetak (lihat style.css @media print), lalu window.print()
// dipanggil supaya user tinggal pilih tujuan "Save as PDF" di dialog cetak browser.

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

  // Gambar (logo/stempel/tanda tangan) dimuat async — tunggu semuanya beres
  // dulu (berhasil atau gagal) supaya tidak ikut kepotong kosong saat dicetak.
  const pending = Array.from(root.querySelectorAll('img')).filter(img => !img.complete);
  if (pending.length === 0) {
    doPrint();
    return;
  }
  let remaining = pending.length;
  const done = () => {
    remaining -= 1;
    if (remaining <= 0) doPrint();
  };
  pending.forEach(img => {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}
