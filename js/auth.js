// ---------- Auth (Login / Daftar / Lupa Kata Sandi) ----------
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { state } from './state.js';

const AUTH_ERROR_MESSAGES = {
  'auth/invalid-email': 'Format email tidak valid.',
  'auth/missing-password': 'Kata sandi wajib diisi.',
  'auth/weak-password': 'Kata sandi minimal 6 karakter.',
  'auth/email-already-in-use': 'Email ini sudah terdaftar. Coba masuk (login) saja.',
  'auth/invalid-credential': 'Email atau kata sandi salah.',
  'auth/wrong-password': 'Email atau kata sandi salah.',
  'auth/user-not-found': 'Akun dengan email ini tidak ditemukan. Daftar dulu di bawah.',
  'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi beberapa saat lagi.',
  'auth/network-request-failed': 'Gagal terhubung ke internet. Periksa koneksi Anda.',
};

function authErrorMessage(code) {
  return AUTH_ERROR_MESSAGES[code] || 'Terjadi kesalahan. Coba lagi.';
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function setAuthMode(mode) {
  state.authMode = mode;
  showAuthError('');
  const title = document.getElementById('authTitle');
  const subtitle = document.getElementById('authSubtitle');
  const submitBtn = document.getElementById('authSubmitBtn');
  const switchText = document.getElementById('authSwitchText');
  const switchLink = document.getElementById('authSwitchLink');
  const confirmWrap = document.getElementById('authConfirmWrap');
  const forgotLink = document.getElementById('authForgotLink');

  if (mode === 'register') {
    title.textContent = 'Buat akun baru';
    subtitle.textContent = 'Daftar untuk mulai mengisi data stok, distribusi, dan keuangan.';
    submitBtn.textContent = 'Daftar';
    switchText.textContent = 'Sudah punya akun?';
    switchLink.textContent = 'Masuk di sini';
    confirmWrap.classList.remove('hidden');
    forgotLink.classList.add('hidden');
  } else {
    title.textContent = 'Masuk ke akun Anda';
    subtitle.textContent = 'Masuk untuk melihat dan mengisi data stok, distribusi, dan keuangan.';
    submitBtn.textContent = 'Masuk';
    switchText.textContent = 'Belum punya akun?';
    switchLink.textContent = 'Daftar di sini';
    confirmWrap.classList.add('hidden');
    forgotLink.classList.remove('hidden');
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  showAuthError('');

  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const submitBtn = document.getElementById('authSubmitBtn');

  if (state.authMode === 'register') {
    const confirm = document.getElementById('authPasswordConfirm').value;
    if (password !== confirm) {
      showAuthError('Kata sandi dan ulangi kata sandi tidak sama.');
      return;
    }
  }

  submitBtn.disabled = true;
  submitBtn.textContent = state.authMode === 'register' ? 'Mendaftarkan...' : 'Masuk...';

  try {
    if (state.authMode === 'register') {
      await createUserWithEmailAndPassword(state.auth, email, password);
    } else {
      await signInWithEmailAndPassword(state.auth, email, password);
    }
    // onAuthStateChanged akan menangani tampilan selanjutnya
  } catch (err) {
    console.error(err);
    showAuthError(authErrorMessage(err.code));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = state.authMode === 'register' ? 'Daftar' : 'Masuk';
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  if (!email) {
    showAuthError('Isi email Anda dulu di atas, lalu klik "Lupa kata sandi?" lagi.');
    return;
  }
  try {
    await sendPasswordResetEmail(state.auth, email);
    showAuthError('');
    alert('Link untuk atur ulang kata sandi sudah dikirim ke ' + email + '. Cek inbox/spam email Anda.');
  } catch (err) {
    console.error(err);
    showAuthError(authErrorMessage(err.code));
  }
}

export function showApp(user) {
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('userEmailPill').textContent = user.email || '';
}

export function showAuthOverlay() {
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('authForm').reset();
  showAuthError('');
}

export function initAuthUI() {
  document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);
  document.getElementById('authSwitchLink').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(state.authMode === 'login' ? 'register' : 'login');
  });
  document.getElementById('authForgotLink').addEventListener('click', handleForgotPassword);
  document.getElementById('btnLogout').addEventListener('click', (e) => {
    e.preventDefault();
    signOut(state.auth);
  });
  setAuthMode('login');
}

export function watchAuthState({ onSignedIn, onSignedOut }) {
  onAuthStateChanged(state.auth, (user) => {
    if (user) {
      showApp(user);
      onSignedIn(user);
    } else {
      showAuthOverlay();
      onSignedOut();
    }
  });
}
