// ---------- Cetak laporan jadi PDF — pakai "Print > Save as PDF" bawaan browser ----------
// Tanpa library eksternal: konten laporan dirender ke satu area khusus (#printRoot)
// yang cuma tampil saat mode cetak (lihat style.css @media print), lalu window.print()
// dipanggil supaya user tinggal pilih tujuan "Save as PDF" di dialog cetak browser.

export function printReport(bodyHtml) {
  let root = document.getElementById('printRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'printRoot';
    document.body.appendChild(root);
  }
  root.innerHTML = `<div class="print-report">${bodyHtml}</div>`;
  window.print();
}
