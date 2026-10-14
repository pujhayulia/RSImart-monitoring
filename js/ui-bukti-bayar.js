// ---------- Upload Bukti Bayar (foto/PDF struk) per catatan pengiriman ARSI ----------
// Disimpan di Firebase Storage (bukan Firestore — filenya bisa berupa foto, terlalu besar untuk
// ditaruh langsung di dokumen Firestore). URL hasil upload disimpan di field buktiBayarUrl pada
// dokumen 'pengiriman' terkait, supaya tombol "Lihat Bukti" tinggal buka link itu.
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { doc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { logActivity } from './activity-log.js';

const UKURAN_MAKS = 10 * 1024 * 1024; // 10MB, dicek sebelum upload supaya gagalnya cepat & jelas
let pendingId = null;

function gantiEkstensi(nama, ext) {
  return nama.replace(/\.[^.]+$/, '') + '.' + ext;
}

/** Perkecil foto di sisi browser (maks 1600px sisi terpanjang, JPEG ~82%) sebelum diunggah, supaya
 * hemat kuota Storage & cepat diupload dari HP di lapangan. PDF dan file yang gagal dikompres
 * dikirim apa adanya — ini optimisasi, bukan syarat, jadi tidak boleh menggagalkan upload. */
async function kompresJikaGambar(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const skala = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * skala), h = Math.round(bitmap.height * skala);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file; // hasil kompres malah lebih besar/gagal — pakai asli
    return new File([blob], gantiEkstensi(file.name, 'jpg'), { type: 'image/jpeg' });
  } catch (e) {
    console.warn('Gagal mengompres foto, unggah file asli', e);
    return file;
  }
}

function findDistItem(id) {
  return state.lastDistItems.find(it => it.id === id);
}

/** Inti proses upload, dipisah dari handler <input type=file> supaya bisa dipanggil langsung
 * (dipakai juga oleh test). Melempar error bila gagal — pemanggil yang menampilkan pesannya. */
export async function uploadBuktiBayar(id, file) {
  const item = findDistItem(id);
  const path = `bukti-bayar/${id}/${Date.now()}_${file.name}`;
  const fileRef = ref(state.storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type });
  const url = await getDownloadURL(fileRef);

  const pathLama = item && item.buktiBayarPath;
  await updateDoc(doc(state.db, 'pengiriman', id), {
    buktiBayarUrl: url,
    buktiBayarNama: file.name,
    buktiBayarPath: path,
    buktiBayarUploadedAt: Date.now(),
    buktiBayarUploadedBy: state.currentUserEmail,
  });
  if (pathLama && pathLama !== path) {
    // Hapus file lama (mis. saat "Ganti Bukti") — upaya terbaik saja, jangan sampai menggagalkan upload yang baru.
    deleteObject(ref(state.storage, pathLama)).catch(() => {});
  }
  logActivity({
    action: 'ubah', modul: 'Distribusi',
    ringkasan: `Upload bukti bayar: ${item ? item.tujuan : id}`,
  });
}

export async function hapusBuktiBayar(id) {
  const item = findDistItem(id);
  if (!item || !item.buktiBayarUrl) return;
  if (!confirm('Hapus bukti bayar ini?')) return;
  await updateDoc(doc(state.db, 'pengiriman', id), {
    buktiBayarUrl: null, buktiBayarNama: null, buktiBayarPath: null,
  });
  if (item.buktiBayarPath) deleteObject(ref(state.storage, item.buktiBayarPath)).catch(() => {});
  logActivity({ action: 'ubah', modul: 'Distribusi', ringkasan: `Hapus bukti bayar: ${item.tujuan}` });
}

async function handleFileChosen(e) {
  const file = e.target.files[0];
  const id = pendingId; pendingId = null;
  if (!file || !id) return;

  if (file.size > UKURAN_MAKS) { alert('Ukuran file maksimal 10MB.'); return; }
  const isGambar = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  if (!isGambar && !isPdf) { alert('File harus berupa foto (JPG/PNG) atau PDF.'); return; }

  const btn = document.querySelector(`[data-buktiid="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Mengunggah...'; }
  try {
    const siap = isGambar ? await kompresJikaGambar(file) : file;
    await uploadBuktiBayar(id, siap);
    // Tombol/link akan ter-render ulang otomatis lewat watchDistribusi saat dokumen berubah.
  } catch (err) {
    console.error(err);
    alert('Gagal mengunggah bukti bayar. Pastikan Anda sudah login dan Firebase Storage sudah diaktifkan (lihat README).');
    if (btn) { btn.disabled = false; btn.textContent = '📎 Upload Bukti Bayar'; }
  }
}

export function triggerUploadBukti(id) {
  pendingId = id;
  const input = document.getElementById('inputBuktiBayar');
  input.value = '';
  input.click();
}

export function initBuktiBayarEvents() {
  document.getElementById('inputBuktiBayar').addEventListener('change', handleFileChosen);
}
