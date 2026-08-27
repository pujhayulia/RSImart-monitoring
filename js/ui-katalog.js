// ---------- Render: Katalog Produk ----------
import { PRODUK, ICONS } from './data.js';
import { formatRupiah, escapeHtml } from './utils.js';
import { printReport } from './print-report.js';

export function renderProdukGrid() {
  const grid = document.getElementById('prodGrid');
  grid.innerHTML = PRODUK.map(p => `
    <div class="prod-card">
      <div class="prod-icon">${ICONS[p.icon]}</div>
      <div class="prod-name">${p.name}</div>
      <div class="prod-size">${p.size}</div>
      <div class="price-row">
        ${p.priceType === 'single' ? `<div class="price-simple">${formatRupiah(p.price)}</div>` :
        `<div class="price-tiers">${p.tiers.map(t => `<div class="price-tier"><div class="tag">${t.label}</div><div class="val">${formatRupiah(t.price)}</div></div>`).join('')}</div>`}
      </div>
    </div>
  `).join('');
}

export function downloadDaftarHargaPdf() {
  const rows = PRODUK.map(p => {
    const harga = p.priceType === 'single'
      ? formatRupiah(p.price)
      : p.tiers.map(t => `${escapeHtml(t.label)}: ${formatRupiah(t.price)}`).join(' / ');
    return `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.size)}</td><td>${harga}</td></tr>`;
  }).join('');

  const body = `
    <h1>Daftar Harga Produk</h1>
    <div class="print-meta">Yayasan Rumah Sehat Indonesia (ARSI)</div>
    <table>
      <thead><tr><th>Produk</th><th>Ukuran</th><th>Harga</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:11px;color:#555;margin-top:6px;">Jerigen sabun 5L: ada biaya tambahan Rp15.000 per pembelian. Refill jerigen (jerigen lama dikembalikan): harga sesuai tabel di atas.</p>
  `;
  printReport(body);
}

export function initKatalogEvents() {
  document.getElementById('btnDownloadKatalog').addEventListener('click', downloadDaftarHargaPdf);
}
