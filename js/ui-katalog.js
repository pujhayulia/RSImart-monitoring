// ---------- Render: Katalog Produk (harga produk bisa diedit langsung dari sini) ----------
// Harga (price/tiers) di PRODUK (js/data.js) dianggap nilai AWAL/seed saja — begitu ada dokumen di
// koleksi Firestore "produkHarga", nilainya menimpa PRODUK secara live (lihat watchProdukHarga()), jadi
// seluruh bagian app yang sudah pakai PRODUK/produkById/priceFor (Distribusi, Invoice, dst) otomatis ikut
// ke harga terbaru tanpa perlu diubah satu-satu — cukup mutasi objek PRODUK yang sama, bukan array baru.
import {
  collection, doc, setDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { PRODUK, ICONS, produkById } from './data.js';
import { formatRupiah, escapeHtml } from './utils.js';
import { printReport } from './print-report.js';
import { logActivity } from './activity-log.js';

let editingProdukId = null;

/** Isi awal koleksi produkHarga dari PRODUK bila masih kosong. Tidak pernah melempar/menggantung: kalau Firestore
 * menolak (mis. aturan keamanan belum memuat produkHarga), cukup log peringatan dan app tetap memakai harga bawaan. */
export async function ensureSeedProdukHarga() {
  const snap = await new Promise((resolve) => {
    const unsub = onSnapshot(
      collection(state.db, 'produkHarga'),
      (qs) => { unsub(); resolve(qs); },
      (err) => { console.warn('Harga produk tidak dapat dimuat dari Firestore — pakai harga bawaan. Pastikan aturan Firestore memuat koleksi "produkHarga" (lihat README).', err); resolve(null); }
    );
  });
  if (snap && snap.empty) {
    for (const p of PRODUK) {
      const payload = p.priceType === 'single' ? { priceType: 'single', price: p.price } : { priceType: 'tier', tiers: p.tiers };
      try { await setDoc(doc(state.db, 'produkHarga', p.id), payload); }
      catch (e) { console.warn('Gagal mengisi awal harga produk', p.id, e); return; }
    }
  }
}

/** Dengarkan harga produk secara real-time — begitu ada perubahan, PRODUK (objek yang sama, dipakai di
 * mana-mana lewat produkById/priceFor) langsung dimutasi supaya semua bagian app ikut ter-update. */
export function watchProdukHarga(onChange) {
  onSnapshot(collection(state.db, 'produkHarga'), (qs) => {
    qs.forEach(d => {
      const produk = produkById(d.id);
      if (!produk) return;
      const data = d.data();
      if (data.priceType === 'single' && typeof data.price === 'number') produk.price = data.price;
      if (data.priceType === 'tier' && Array.isArray(data.tiers)) produk.tiers = data.tiers;
    });
    onChange();
  }, (err) => console.error('Gagal memuat harga produk', err));
}

async function simpanHargaProduk(id) {
  const produk = produkById(id);
  if (!produk) return;
  const btn = document.querySelector(`[data-price-save="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  let payload;
  if (produk.priceType === 'single') {
    const input = document.getElementById(`priceInput-${id}`);
    const val = Number(input.value);
    if (!input.value || isNaN(val) || val < 0) { alert('Harga tidak valid.'); if (btn) { btn.disabled = false; btn.textContent = 'Simpan'; } return; }
    payload = { priceType: 'single', price: val };
  } else {
    const tiers = produk.tiers.map((t, i) => {
      const input = document.getElementById(`priceInputTier-${id}-${i}`);
      return { label: t.label, price: Number(input.value) };
    });
    if (tiers.some(t => isNaN(t.price) || t.price < 0)) { alert('Harga tidak valid.'); if (btn) { btn.disabled = false; btn.textContent = 'Simpan'; } return; }
    payload = { priceType: 'tier', tiers };
  }

  try {
    await setDoc(doc(state.db, 'produkHarga', id), { ...payload, updatedAt: Date.now(), updatedBy: state.currentUserEmail });
    logActivity({ action: 'ubah', modul: 'Katalog', ringkasan: `Ubah harga ${produk.name} (${produk.size})` });
    editingProdukId = null;
    renderProdukGrid();
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan harga. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
    if (btn) { btn.disabled = false; btn.textContent = 'Simpan'; }
  }
}

function hargaCardHtml(p) {
  if (editingProdukId === p.id) {
    const fields = p.priceType === 'single'
      ? `<label>Harga per ${escapeHtml(p.satuan)}<input type="number" id="priceInput-${p.id}" value="${p.price}"></label>`
      : p.tiers.map((t, i) => `<label>${escapeHtml(t.label)} (per ${escapeHtml(p.satuan)})<input type="number" id="priceInputTier-${p.id}-${i}" value="${t.price}"></label>`).join('');
    return `
      <div class="price-edit-form">
        ${fields}
        <div class="price-edit-actions">
          <button type="button" class="btn-ghost" data-price-cancel="${p.id}">Batal</button>
          <button type="button" class="btn" data-price-save="${p.id}">Simpan</button>
        </div>
      </div>`;
  }
  return `
    <div class="price-row">
      ${p.priceType === 'single'
      ? `<div class="price-simple">${formatRupiah(p.price)}<span class="price-satuan"> / ${escapeHtml(p.satuan)}</span></div>`
      : `<div class="price-tiers">${p.tiers.map(t => `<div class="price-tier"><div class="tag">${escapeHtml(t.label)}</div><div class="val">${formatRupiah(t.price)}</div></div>`).join('')}<div class="price-satuan-tiers">per ${escapeHtml(p.satuan)}</div></div>`}
    </div>
    <button type="button" class="btn-ghost price-edit-btn" data-price-edit="${p.id}">✏️ Edit Harga</button>`;
}

export function renderProdukGrid() {
  const grid = document.getElementById('prodGrid');
  grid.innerHTML = PRODUK.map(p => `
    <div class="prod-card">
      <div class="prod-icon">${ICONS[p.icon]}</div>
      <div class="prod-name">${p.name}</div>
      <div class="prod-size">${p.size}</div>
      ${hargaCardHtml(p)}
    </div>
  `).join('');

  grid.querySelectorAll('[data-price-edit]').forEach(btn => {
    btn.addEventListener('click', () => { editingProdukId = btn.dataset.priceEdit; renderProdukGrid(); });
  });
  grid.querySelectorAll('[data-price-cancel]').forEach(btn => {
    btn.addEventListener('click', () => { editingProdukId = null; renderProdukGrid(); });
  });
  grid.querySelectorAll('[data-price-save]').forEach(btn => {
    btn.addEventListener('click', () => simpanHargaProduk(btn.dataset.priceSave));
  });
}

export function downloadDaftarHargaPdf() {
  const rows = PRODUK.map(p => {
    const harga = p.priceType === 'single'
      ? `${formatRupiah(p.price)} / ${escapeHtml(p.satuan)}`
      : p.tiers.map(t => `${escapeHtml(t.label)}: ${formatRupiah(t.price)}`).join(' / ') + ` (per ${escapeHtml(p.satuan)})`;
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
