# Monitoring Operasional — Yayasan Rumah Sehat Indonesia

Website untuk katalog produk, rekap stok galon harian, pencatatan distribusi
pengiriman, koperasi bahan makanan (pembelian & distribusi ke SPPG), dan rekap
keuangan otomatis. Data tersimpan di **Firebase (Firestore)** secara
real-time, jadi semua orang yang membuka situs ini melihat dan mengisi data
yang sama — dari HP atau lokasi mana pun.

Setelah login, pengguna memilih salah satu dari **dua modul yang sepenuhnya
terpisah** — datanya sendiri-sendiri, tidak tercampur:

- **Web RSI**: Beranda, Katalog Produk, Stok Gudang RSI, Distribusi, Keuangan.
- **Koperasi Bahan Makanan**: Beranda, Pembelian Bahan Makanan, Distribusi ke
  SPPG, Laporan Keuangan Koperasi.

Di dalam sebuah modul, tiap fitur terasa seperti halaman sendiri (URL berubah,
mis. `#/rsi/katalog` atau `#/koperasi/pembelian`) tanpa reload halaman, supaya
data real-time dan sesi login tetap lancar. Ada tombol **"Ganti Modul"** di
sidebar untuk kembali ke layar pilih modul kapan saja.

Semua tambah/ubah/hapus data tercatat otomatis di halaman **"Riwayat
Aktivitas"** (bisa diakses dari kedua modul) — mencatat siapa (email akun),
kapan, dan perubahan apa, termasuk jejak data yang sudah dihapus. Setiap baris
data di modul lain juga menampilkan "Diinput oleh ..." dengan email akun yang
sedang login saat menyimpan.

## Isi folder

```text
index.html                 → struktur halaman
style.css                   → tampilan/desain
README.md                   → panduan ini
js/
  main.js                    → titik masuk aplikasi (inisialisasi Firebase & wiring UI)
  router.js                   → navigasi sadar-modul (sidebar, hash URL "#/modul/halaman", tanpa reload)
  activity-log.js             → catat & tampilkan Riwayat Aktivitas (siapa, kapan, apa)
  csv-export.js                → bangun & unduh file CSV (tanpa library eksternal)
  print-report.js              → cetak laporan jadi PDF lewat "Print > Save as PDF" browser
  firebase-config.js         → tempat Anda menempel konfigurasi Firebase
  state.js                   → state bersama antar modul (koneksi Firebase, modul aktif, cache data)
  data.js                    → daftar produk, harga, dan data awal (seed)
  utils.js                   → fungsi bantu (format tanggal/rupiah/jam, escaping, filter rentang tanggal)
  auth.js                    → layar login / daftar / lupa kata sandi
  ui-beranda.js                → Beranda modul Web RSI
  ui-katalog.js               → render Katalog Produk
  ui-gudang.js                → render & simpan Stok Gudang RSI
  ui-lokasi.js                → daftar lokasi tujuan pengiriman (dinamis)
  ui-distribusi.js            → form & log Distribusi/Pengiriman
  ui-dist-item.js             → komponen baris pengiriman (dipakai Distribusi & Piutang)
  ui-keuangan.js               → Rekap Keuangan (dihitung otomatis dari pengiriman)
  ui-beranda-koperasi.js       → Beranda modul Koperasi Bahan Makanan
  ui-pembelian.js              → Koperasi: pembelian bahan makanan dari toko/supplier
  ui-distribusi-sppg.js        → Koperasi: distribusi/penjualan bahan makanan ke SPPG
  ui-laporan-keuangan-koperasi.js → Koperasi: gabungan Pembelian+Distribusi, buku kas, ekspor PDF/CSV
```

Situs ini murni HTML/CSS/JS modul ES (tanpa proses build/bundler), jadi bisa
langsung di-hosting di GitHub Pages.

---

## Langkah 1 — Buat project Firebase (gratis)

1. Buka [console.firebase.google.com](https://console.firebase.google.com), login dengan akun Google.
2. Klik **"Add project"** / **"Tambahkan project"**.
3. Beri nama, misalnya `rsi-monitoring`. Lanjutkan sampai selesai (Google Analytics boleh dimatikan, tidak wajib).

## Langkah 2 — Aktifkan Firestore Database

1. Di menu kiri, buka **Build → Firestore Database**.
2. Klik **"Create database"**.
3. Pilih lokasi server terdekat, misalnya `asia-southeast2 (Jakarta)`.
4. Pilih mode **Production**.

## Langkah 3 — Aktifkan Email/Password Authentication

Situs ini memakai login dengan akun (email + kata sandi) — jadi setiap orang
yang mengisi data punya akunnya sendiri, dan database tetap tidak bisa diisi
sembarang orang dari luar situs Anda.

1. Di menu kiri, buka **Build → Authentication**.
2. Klik **"Get started"**.
3. Di tab **Sign-in method**, aktifkan provider **Email/Password**.
4. Setelah situs berjalan, tim Anda bisa langsung **daftar akun sendiri**
   lewat tombol "Daftar di sini" di layar login — tidak perlu dibuatkan satu
   per satu lewat Firebase Console.

## Langkah 4 — Atur aturan keamanan Firestore

1. Masih di **Firestore Database**, buka tab **Rules**.
2. Ganti isinya dengan:

   ```text
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rekap/{date} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /pengiriman/{id} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /lokasi/{id} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /pembelianBahanMakanan/{id} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /distribusiSppg/{id} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /activityLog/{id} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```

3. Klik **Publish**.

> Aturan ini artinya: **siapa saja bisa melihat data**, tapi **hanya orang
> yang sudah login** (punya akun email/kata sandi di situs ini) yang bisa
> menambah/mengubah data. Ini cukup untuk tim internal. Kalau ke depannya
> butuh kontrol lebih ketat lagi (misalnya hanya email tertentu yang boleh
> mengisi), Firestore Rules bisa dipersempit lebih lanjut — tinggal beri tahu
> saya kalau mau ditingkatkan.

## Langkah 5 — Ambil konfigurasi & tempel ke `js/firebase-config.js`

1. Di Firebase Console, klik ⚙️ **Project settings** (di pojok kiri atas, dekat "Project Overview").
2. Scroll ke bagian **"Your apps"**, klik ikon web **`</>`**.
3. Beri nama app (bebas, mis. `rsi-web`), klik **Register app**. Anda **tidak perlu** centang Firebase Hosting.
4. Firebase akan menampilkan blok `firebaseConfig = { ... }`. Salin nilai-nilainya.
5. Buka file `js/firebase-config.js` di folder ini, dan ganti setiap nilai dengan yang sesuai. Contoh:

```js
export const firebaseConfig = {
  apiKey: "AIzaSyD...",
  authDomain: "rsi-monitoring.firebaseapp.com",
  projectId: "rsi-monitoring",
  storageBucket: "rsi-monitoring.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef123456",
};
```

Simpan file. Ini aman untuk di-publish ke GitHub — konfigurasi ini memang
untuk dipakai di browser, bukan rahasia (keamanan datanya diatur lewat
Firestore Rules di Langkah 4, bukan lewat menyembunyikan config ini).

## Langkah 6 — Coba dulu di komputer (opsional tapi disarankan)

Karena situs ini memakai modul ES (`type="module"`), buka file lewat server
lokal, bukan `file://`. Cara termudah kalau Anda punya Python:

```bash
cd rsi-site
python3 -m http.server 8000
```

Lalu buka `http://localhost:8000` di browser. Cek status di bawah judul —
harus berubah jadi **"Tersambung — data sinkron real-time"**.

## Langkah 7 — Publish ke GitHub Pages

1. Buat repository baru di GitHub, misalnya `rsi-monitoring`.
2. Upload semua file & folder di sini (`index.html`, `style.css`, folder
   `js/` lengkap dengan `firebase-config.js` yang sudah diisi, `README.md`)
   ke repository tersebut — bisa lewat **"Add file → Upload files"** di web
   GitHub, atau lewat `git push`.
3. Di repository, buka **Settings → Pages**.
4. Pada **"Build and deployment"**, pilih **Source: Deploy from a branch**.
5. Pilih **Branch: main**, folder **/ (root)**, klik **Save**.
6. Tunggu 1–2 menit, lalu situs akan aktif di:
   `https://<username-anda>.github.io/rsi-monitoring/`

Bagikan link itu ke semua orang yang perlu mengisi/melihat data — semua akan
melihat data yang sama secara real-time.

---

## Catatan pemakaian

- **Rekap Stok**: data 16 Juli 2026 sudah otomatis terisi sebagai contoh saat
  pertama kali situs terhubung ke database. Gunakan tombol **"+ Update Stok
  Gudang"** untuk mencatat hari berikutnya.
- **Distribusi**: setiap pengiriman galon (ke lokasi lama maupun baru) dicatat
  di sini, jadi ke mana pun barang dikirim akan tetap terdata.
- **Koperasi Bahan Makanan**: modul terpisah dari Web RSI (sidebar & halaman
  sendiri), dengan collection Firestore sendiri (`pembelianBahanMakanan` dan
  `distribusiSppg`) — strukturnya beda:
  - **Pembelian**: satu barang yang dibeli = satu dokumen tersendiri, dengan
    tanggal & jam otomatis dari Firestore server timestamp.
  - **Distribusi ke SPPG**: satu **nota pengiriman** = satu dokumen, berisi
    array `items` yang bisa memuat banyak barang sekaligus. Tanggal & jam
    kirim diisi manual (sesuai kapan barang benar-benar dikirim), sedangkan
    waktu pencatatan ke sistem tetap otomatis (server timestamp) — keduanya
    disimpan terpisah.
- **Riwayat Aktivitas**: transparansi tim — setiap tambah/ubah/hapus data di
  kedua modul tercatat di collection `activityLog` (siapa, kapan, ringkasan
  perubahan), termasuk jejak data yang sudah dihapus. Bisa diakses dari
  sidebar modul mana pun. Halaman ini punya filter (modul, jenis aksi,
  pencarian email, rentang tanggal) supaya tetap gampang ditelusuri walau
  datanya makin banyak.
- **Edit data**: baris di Pengiriman RSI, Pembelian, dan Distribusi SPPG bisa
  diklik ikon ✏️ untuk mengisi ulang form dengan data yang sudah ada (untuk
  nota SPPG, semua baris barangnya ikut dimuat ulang) — tinggal ubah lalu
  klik tombol "Update...". Perubahan tercatat di Riwayat Aktivitas (aksi
  "Ubah"), dan waktu/pembuat data asli (`createdAt`/`createdBy`) tetap
  dipertahankan — hanya `updatedAt`/`updatedBy` yang ditambahkan.
- **Daftar Harga Katalog**: tombol "Download Daftar Harga (PDF)" di halaman
  Katalog Produk, untuk dibagikan ke pelanggan/agen.
- **Download Laporan**: setiap halaman Koperasi (Pembelian, Distribusi SPPG,
  Stok Gudang RSI) punya filter rentang tanggal + tombol download **CSV**
  (langsung bisa dibuka di Excel/Google Sheets). Halaman **Laporan Keuangan
  Koperasi** juga punya tombol **Download PDF** — ini memakai fitur
  "Print → Save as PDF" bawaan browser (diarahkan otomatis ke tampilan
  laporan yang sudah dirapikan khusus cetak), bukan library PDF pihak
  ketiga. Semua ini **tanpa library/dependency tambahan** — konsisten dengan
  prinsip situs ini sejak awal (murni HTML/CSS/JS, tanpa build).
- Situs ini murni front-end, jadi biaya hosting **Rp0** (GitHub Pages gratis)
  dan Firebase juga gratis untuk pemakaian skala kecil seperti ini (jauh di
  bawah kuota gratis/hari).

## Kalau ingin dikembangkan lebih lanjut

- Kontrol akses berbasis peran (mis. admin vs staf lapangan).
- Grafik tren stok harian.
- Rekap total pengiriman per lokasi (akumulasi bulanan).
- File .xlsx asli (bukan CSV) atau PDF sekali-klik tanpa dialog print — bisa
  dibuat, tapi perlu menambah library eksternal (SheetJS/jsPDF) via CDN,
  yang berarti situs jadi bergantung pada layanan pihak ketiga saat runtime.

Beri tahu saya kalau salah satu dari ini mau dibuatkan.
