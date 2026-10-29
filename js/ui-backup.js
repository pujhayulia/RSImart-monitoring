// ---------- Backup Semua Data — unduh seluruh koleksi Firestore jadi satu file JSON ----------
// Dipasang di halaman Riwayat Aktivitas karena diakses dari modul mana pun. Selalu ambil data
// LANGSUNG dari Firestore (bukan dari cache state), supaya tidak kepotong oleh limit() milik
// masing-masing halaman dan hasilnya benar-benar lengkap.
import { collection, getDocs, doc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { logActivity } from './activity-log.js';
import { timestampToLocalDateIso } from './utils.js';

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

// ---------- Pangkas Data Lama (sebelum Juli 2026) ----------
// Koleksi pembelianBahanMakanan membengkak jadi puluhan ribu dokumen (draft kosong + arsip lama), bikin
// setiap buka halaman Pembelian menarik puluhan ribu baca Firestore sekaligus -- sampai kena limit baca
// harian paket gratis (quota exceeded), jadi data yang baru disimpan pun tidak kelihatan. Pujha minta
// dipangkas, sisakan Juli 2026 sampai sekarang saja. Supaya data lama tidak benar-benar hilang, backup
// lengkap selalu diunduh dulu secara otomatis sebelum satu dokumen pun dihapus.
const CUTOFF_PANGKAS = '2026-07-01';

/** Tanggal efektif satu catatan Pembelian untuk keperluan pangkas -- sama seperti pembelianTanggalIso()
 * di ui-pembelian.js (tidak diimpor langsung supaya alat ini tetap berdiri sendiri, tidak bergantung
 * ke state.lastPoSppgItems yang mungkin belum lengkap): arsip impor pakai tanggal PO-nya, pembelian
 * biasa pakai createdAt. */
function tanggalEfektifPembelian(it, poMap) {
  if (it.importBatch && it.poId && poMap[it.poId] && poMap[it.poId].tanggalPo) return poMap[it.poId].tanggalPo;
  return timestampToLocalDateIso(it.createdAt);
}

async function pangkasDataLama() {
  const btn = document.getElementById('btnPangkasDataLama');
  if (btn) { btn.disabled = true; btn.textContent = 'Membuat backup dulu...'; }
  try {
    // 1) Backup otomatis dulu -- data lama dipindah ke file, bukan dihapus begitu saja tanpa jejak.
    await downloadBackupSemuaData();

    if (btn) btn.textContent = 'Menghitung data lama...';
    const [poDocs, pembelianDocs, distDocs, biayaDocs] = await Promise.all([
      fetchAll('poSppg'), fetchAll('pembelianBahanMakanan'), fetchAll('distribusiSppg'), fetchAll('biayaOperasional'),
    ]);
    const poMap = {};
    poDocs.forEach(po => { poMap[po.id] = po; });

    const poLama = poDocs.filter(po => po.tanggalPo && po.tanggalPo < CUTOFF_PANGKAS);
    const pembelianLama = pembelianDocs.filter(it => {
      const tgl = tanggalEfektifPembelian(it, poMap);
      return tgl && tgl < CUTOFF_PANGKAS;
    });
    const distLama = distDocs.filter(n => n.tanggalKirim && n.tanggalKirim < CUTOFF_PANGKAS);
    const biayaLama = biayaDocs.filter(b => b.tanggal && b.tanggal < CUTOFF_PANGKAS);
    const total = poLama.length + pembelianLama.length + distLama.length + biayaLama.length;

    if (total === 0) {
      alert('Backup sudah terunduh. Tidak ada data sebelum 1 Juli 2026 yang ditemukan -- tidak ada yang perlu dipangkas.');
      return;
    }

    const lanjut = confirm(
      `File backup lengkap sudah terunduh ke folder Download Anda -- simpan baik-baik.\n\n` +
      `Akan MENGHAPUS PERMANEN dari database (semua bertanggal sebelum 1 Juli 2026):\n` +
      `• ${poLama.length} PO dari SPPG\n` +
      `• ${pembelianLama.length} catatan Pembelian Bahan Makanan\n` +
      `• ${distLama.length} nota Distribusi ke SPPG\n` +
      `• ${biayaLama.length} catatan Biaya Operasional\n\n` +
      `Data Juli 2026 dan seterusnya TIDAK akan disentuh.\n\n` +
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
    await hapusSemua('poSppg', poLama);
    await hapusSemua('pembelianBahanMakanan', pembelianLama);
    await hapusSemua('distribusiSppg', distLama);
    await hapusSemua('biayaOperasional', biayaLama);

    logActivity({
      action: 'hapus',
      modul: 'Backup Data',
      ringkasan: `Pangkas data sebelum 1 Juli 2026: ${poLama.length} PO, ${pembelianLama.length} pembelian, ${distLama.length} distribusi, ${biayaLama.length} biaya operasional (backup sudah diunduh sebelumnya)`,
    });
    alert(`Selesai. ${total} dokumen lama (sebelum Juli 2026) sudah dihapus permanen. Data Juli 2026 dan seterusnya tetap utuh. Backup file-nya ada di folder Download Anda.`);
  } catch (e) {
    console.error(e);
    alert('Gagal memangkas data. Pastikan Anda sudah login, lalu coba lagi. (Kalau errornya soal kuota Firestore habis, tunggu reset atau upgrade ke Blaze dulu baru coba lagi.)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Pangkas Data Sebelum Juli 2026'; }
  }
}

export function initBackupEvents() {
  const btn = document.getElementById('btnDownloadBackup');
  if (btn) btn.addEventListener('click', downloadBackupSemuaData);
  const btnPangkas = document.getElementById('btnPangkasDataLama');
  if (btnPangkas) btnPangkas.addEventListener('click', pangkasDataLama);
}
