// ---------- Backup Semua Data — unduh seluruh koleksi Firestore jadi satu file JSON ----------
// Dipasang di halaman Riwayat Aktivitas karena diakses dari modul mana pun. Selalu ambil data
// LANGSUNG dari Firestore (bukan dari cache state), supaya tidak kepotong oleh limit() milik
// masing-masing halaman dan hasilnya benar-benar lengkap.
import { collection, getDocs, doc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { logActivity } from './activity-log.js';

const COLLECTIONS = [
  'rekap', 'pengiriman', 'lokasi', 'poSppg', 'pembelianBahanMakanan',
  'distribusiSppg', 'biayaOperasional', 'activityLog',
];

function jsonReplacer(key, value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return value;
}

function fileTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${p(d.getDate())}${bulan[d.getMonth()]}${d.getFullYear()}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function fetchAll(name) {
  const snap = await getDocs(collection(state.db, name));
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
  return docs;
}

export async function downloadBackupSemuaData() {
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengambil data...'; }
  try {
    const collections = {};
    for (const name of COLLECTIONS) {
      collections[name] = await fetchAll(name);
    }
    const totalDokumen = Object.values(collections).reduce((sum, arr) => sum + arr.length, 0);

    const payload = {
      dibuatPada: new Date().toISOString(),
      dibuatOleh: state.currentUserEmail || 'tidak diketahui',
      totalDokumen,
      collections,
    };
    const json = JSON.stringify(payload, jsonReplacer, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Backup-RSI-Site-${fileTag()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logActivity({
      action: 'tambah',
      modul: 'Backup Data',
      ringkasan: `Unduh backup lengkap seluruh data (${totalDokumen} dokumen dari ${COLLECTIONS.length} koleksi)`,
    });
  } catch (e) {
    console.error(e);
    alert('Gagal mengambil data untuk backup. Pastikan Anda sudah login, lalu coba lagi.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Download Backup Semua Data (JSON)'; }
  }
}

// ---------- Hapus Data Arsip Impor ----------
// Koleksi pembelianBahanMakanan membengkak jadi puluhan ribu dokumen, bikin setiap buka halaman
// Pembelian menarik puluhan ribu baca Firestore sekaligus -- sampai kena limit baca harian paket
// gratis (quota exceeded), jadi data yang baru disimpan pun tidak kelihatan.
// Pujha eksplisit minta: JANGAN berdasarkan tanggal (data yang diinput client lewat form biasa bisa
// saja bertanggal lama juga) -- target HARUS cuma data hasil tombol "Import Arsip" (LPJ April-Agustus,
// LPJ Sept-Okt, dll), ditandai field importBatch. Data yang diinput manual lewat "Catat PO Baru" /
// "Catat Pembelian Baru" / dst TIDAK PERNAH diberi importBatch (lihat savePo()/savePembelian()), jadi
// filter ini aman -- tidak mungkin ikut menghapus input client. Master Barang & Data Supplier sengaja
// TIDAK disentuh sama sekali oleh alat ini (Pujha minta keduanya tetap ada apa adanya).
// Backup lengkap selalu diunduh dulu secara otomatis sebelum satu dokumen pun dihapus.

/** true kalau sebuah catatan Pembelian berasal dari arsip impor -- ditandai importBatch langsung
 * di dirinya sendiri, ATAU tertaut (poId) ke PO yang importBatch-nya terisi (draft yang dibuat
 * otomatis dari PO arsip tidak selalu punya importBatch-nya sendiri). Sama persis logikanya dengan
 * pembelianIsArsip() di ui-pembelian.js. */
function pembelianDariArsip(it, poMap) {
  if (it.importBatch) return true;
  const po = it.poId ? poMap[it.poId] : null;
  return !!(po && po.importBatch);
}

async function pangkasDataLama() {
  const btn = document.getElementById('btnPangkasDataLama');
  if (btn) { btn.disabled = true; btn.textContent = 'Membuat backup dulu...'; }
  try {
    // 1) Backup otomatis dulu -- data arsip dipindah ke file, bukan dihapus begitu saja tanpa jejak.
    await downloadBackupSemuaData();

    if (btn) btn.textContent = 'Menghitung data arsip...';
    const [poDocs, pembelianDocs, distDocs, biayaDocs] = await Promise.all([
      fetchAll('poSppg'), fetchAll('pembelianBahanMakanan'), fetchAll('distribusiSppg'), fetchAll('biayaOperasional'),
    ]);
    const poMap = {};
    poDocs.forEach(po => { poMap[po.id] = po; });

    const poArsip = poDocs.filter(po => !!po.importBatch);
    const pembelianArsip = pembelianDocs.filter(it => pembelianDariArsip(it, poMap));
    const distArsip = distDocs.filter(n => !!n.importBatch);
    const biayaArsip = biayaDocs.filter(b => !!b.importBatch);
    const total = poArsip.length + pembelianArsip.length + distArsip.length + biayaArsip.length;

    if (total === 0) {
      alert('Backup sudah terunduh. Tidak ada data arsip impor yang ditemukan -- tidak ada yang perlu dipangkas.');
      return;
    }

    const lanjut = confirm(
      `File backup lengkap sudah terunduh ke folder Download Anda -- simpan baik-baik.\n\n` +
      `Akan MENGHAPUS PERMANEN data hasil "Import Arsip" (LPJ April-Agustus, LPJ Sept-Okt, dll) dari database:\n` +
      `• ${poArsip.length} PO dari SPPG\n` +
      `• ${pembelianArsip.length} catatan Pembelian Bahan Makanan\n` +
      `• ${distArsip.length} nota Distribusi ke SPPG\n` +
      `• ${biayaArsip.length} catatan Biaya Operasional\n\n` +
      `Data yang diinput MANUAL oleh client/staf lewat form biasa (PO, Pembelian, Distribusi, Biaya Operasional) ` +
      `TIDAK akan disentuh sama sekali, berapa pun lamanya -- hanya data hasil impor arsip yang dihapus. ` +
      `Master Barang & Data Supplier juga tidak disentuh.\n\n` +
      `Lanjutkan hapus permanen?`
    );
    if (!lanjut) {
      alert('Dibatalkan -- tidak ada data yang dihapus. File backup tetap ada di folder Download Anda.');
      return;
    }

    if (btn) btn.textContent = `Menghapus 0/${total}...`;
    let selesai = 0;
    const hapusSemua = async (namaKoleksi, docs) => {
      for (let i = 0; i < docs.length; i += 450) {
        const batch = writeBatch(state.db);
        docs.slice(i, i + 450).forEach(d => batch.delete(doc(state.db, namaKoleksi, d.id)));
        await batch.commit();
        selesai += Math.min(450, docs.length - i);
        if (btn) btn.textContent = `Menghapus ${selesai}/${total}...`;
      }
    };
    await hapusSemua('poSppg', poArsip);
    await hapusSemua('pembelianBahanMakanan', pembelianArsip);
    await hapusSemua('distribusiSppg', distArsip);
    await hapusSemua('biayaOperasional', biayaArsip);

    logActivity({
      action: 'hapus',
      modul: 'Backup Data',
      ringkasan: `Pangkas data arsip impor: ${poArsip.length} PO, ${pembelianArsip.length} pembelian, ${distArsip.length} distribusi, ${biayaArsip.length} biaya operasional (backup sudah diunduh sebelumnya; data input manual tidak disentuh)`,
    });
    alert(`Selesai. ${total} dokumen arsip impor sudah dihapus permanen. Semua data yang diinput manual (client/staf) tetap utuh. Backup file-nya ada di folder Download Anda.`);
  } catch (e) {
    console.error(e);
    alert('Gagal memangkas data. Pastikan Anda sudah login, lalu coba lagi. (Kalau errornya soal kuota Firestore habis, tunggu reset atau upgrade ke Blaze dulu baru coba lagi.)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Hapus Data Arsip Impor'; }
  }
}

export function initBackupEvents() {
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) btn.addEventListener('click', downloadBackupSemuaData);
  const btnPangkas = document.getElementById('btnPangkasDataLama');
  if (btnPangkas) btnPangkas.addEventListener('click', pangkasDataLama);
}
