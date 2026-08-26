// ---------- Render: Katalog Produk ----------
import { PRODUK, ICONS } from './data.js';
import { formatRupiah } from './utils.js';

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
