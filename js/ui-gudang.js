// ---------- Render & aksi: Stok Gudang RSI ----------
import { doc, setDoc, getDoc, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { ICONS, PRODUK_NON_GALON, SEED_DATE, SEED_GUDANG } from './data.js';
import { formatDate } from './utils.js';

export function renderGudang(rekap) {
  const box = document.getElementById('gudangBox');
  const stokGrid = document.getElementById('stokProdukGrid');
  if (!rekap) {
    box.innerHTML = `<div class="no-data">Belum ada data stok untuk tanggal ini.</div>`;
    stokGrid.innerHTML = `<div class="no-data">Belum ada data.</div>`;
    document.getElementById('totalIsi').textContent = '–';
    document.getElementById('totalKosong').textContent = '–';
    document.getElementById('totalPeredaran').textContent = '–';
    return;
  }
  const hasData = rekap.isi !== null && rekap.isi !== undefined && rekap.kosong !== null && rekap.kosong !== undefined;
  let fillPct = 0;
  if (hasData) {
    const tot = (rekap.isi || 0) + (rekap.kosong || 0);
    fillPct = tot > 0 ? Math.round((rekap.isi / tot) * 100) : 0;
  }
  box.innerHTML = `
    <div class="jug-card jug-card--single">
      <div class="jug jug--lg"><div class="jug-fill" style="height:${hasData ? fillPct : 0}%;"></div></div>
      <div class="jug-info">
        <div class="loc-name">Air ARSI Galon 19L <span class="loc-badge">PUSAT</span></div>
        ${hasData ?
          `<div class="jug-stats"><span class="isi">Isi: ${rekap.isi} galon</span><span class="kosong">Kosong: ${rekap.kosong} galon</span></div>`
          : `<div class="no-data no-data--inline">Belum ada data</div>`}
      </div>
    </div>`;
  document.getElementById('totalIsi').textContent = (rekap.isi ?? '–') + ' galon';
  document.getElementById('totalKosong').textContent = (rekap.kosong ?? '–') + ' galon';
  document.getElementById('totalPeredaran').textContent = (rekap.peredaran ?? '–') + ' galon';

  const stokProduk = rekap.stokProduk || {};
  stokGrid.innerHTML = PRODUK_NON_GALON.map(p => {
    const qty = stokProduk[p.id];
    const hasQty = qty !== null && qty !== undefined && qty !== '';
    return `
      <div class="stok-mini-card">
        <div class="stok-mini-icon">${ICONS[p.icon]}</div>
        <div>
          <div class="stok-mini-name">${p.name}</div>
          <div class="stok-mini-size">${p.size}</div>
          <div class="stok-mini-qty">${hasQty ? `${qty} ${p.satuan}` : `<span class="no-data no-data--inline">Belum ada data</span>`}</div>
        </div>
      </div>`;
  }).join('');
}

export function renderStokProdukFormInputs(existingStok) {
  const wrap = document.getElementById('stokProdukFormGrid');
  wrap.innerHTML = PRODUK_NON_GALON.map(p => {
    const cur = (existingStok && existingStok[p.id] !== undefined && existingStok[p.id] !== null) ? existingStok[p.id] : '';
    return `
    <div class="form-field">
      <label>${p.name} — ${p.size} (${p.satuan})</label>
      <input type="number" id="stokProduk_${p.id}" value="${cur}" placeholder="-">
    </div>`;
  }).join('');
}

export async function ensureSeedGudang() {
  const ref = doc(state.db, 'rekap', SEED_DATE);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, SEED_GUDANG);
  }
}

export function watchGudangDates() {
  onSnapshot(collection(state.db, 'rekap'), (qs) => {
    const dates = [];
    qs.forEach(d => dates.push(d.id));
    if (dates.length === 0) return;
    dates.sort().reverse();
    const sel = document.getElementById('rekapDateSelect');
    const prevValue = sel.value;
    sel.innerHTML = dates.map(d => `<option value="${d}">${formatDate(d)}</option>`).join('');
    if (dates.includes(prevValue)) {
      sel.value = prevValue;
      state.currentDate = prevValue;
    } else {
      state.currentDate = dates[0];
      sel.value = state.currentDate;
    }
    watchSelectedGudang(state.currentDate);
  }, (err) => console.error('Gagal memuat daftar tanggal', err));
}

export function watchSelectedGudang(date) {
  if (state.gudangUnsub) state.gudangUnsub();
  state.gudangUnsub = onSnapshot(doc(state.db, 'rekap', date), (snap) => {
    renderGudang(snap.exists() ? snap.data() : null);
  }, (err) => console.error('Gagal memuat stok gudang', err));
}

export async function saveGudang() {
  const dateInput = document.getElementById('newRekapDate').value;
  const isi = document.getElementById('gudangIsi').value;
  const kosong = document.getElementById('gudangKosong').value;
  const peredaran = document.getElementById('gudangPeredaran').value;
  if (!dateInput) { alert('Pilih tanggal terlebih dahulu.'); return; }

  const stokProduk = {};
  PRODUK_NON_GALON.forEach(p => {
    const el = document.getElementById('stokProduk_' + p.id);
    const v = el ? el.value : '';
    stokProduk[p.id] = v === '' ? null : Number(v);
  });

  const rekap = {
    isi: isi === '' ? null : Number(isi),
    kosong: kosong === '' ? null : Number(kosong),
    peredaran: peredaran === '' ? null : Number(peredaran),
    stokProduk,
    updatedAt: Date.now()
  };
  const btn = document.getElementById('btnSaveRekap');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    await setDoc(doc(state.db, 'rekap', dateInput), rekap);
    document.getElementById('formPanel').classList.remove('open');
    state.currentDate = dateInput;
    watchSelectedGudang(dateInput);
    const sel = document.getElementById('rekapDateSelect');
    if (![...sel.options].some(o => o.value === dateInput)) {
      const opt = document.createElement('option');
      opt.value = dateInput; opt.textContent = formatDate(dateInput);
      sel.insertBefore(opt, sel.firstChild);
    }
    sel.value = dateInput;
  } catch (e) {
    console.error(e);
    alert('Gagal menyimpan. Pastikan Anda sudah login dan aturan Firestore sudah benar.');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Stok Gudang';
  }
}
