// ---------- Ekspor CSV — tanpa library eksternal, langsung bisa dibuka di Excel/Google Sheets ----------

function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(row => lines.push(row.map(csvEscape).join(',')));
  // ﻿ (BOM) supaya Excel membaca karakter non-ASCII (mis. "Rp", "–") dengan benar.
  return '﻿' + lines.join('\r\n');
}

export function downloadCsv(filename, headers, rows) {
  const csv = buildCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** "05 Jan - 05 Feb 2026" → dipakai untuk nama file & judul laporan. dari/sampai: "YYYY-MM-DD" atau kosong. */
export function dateRangeLabel(dari, sampai, formatDate) {
  if (!dari && !sampai) return 'Semua Tanggal';
  if (dari && !sampai) return `Sejak ${formatDate(dari)}`;
  if (!dari && sampai) return `Sampai ${formatDate(sampai)}`;
  return `${formatDate(dari)} - ${formatDate(sampai)}`;
}

/** "05Jan-05Feb2026" → dipakai di nama file, tanpa spasi/karakter aneh. */
export function dateRangeFileTag(dari, sampai) {
  const compact = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return `${d}${bulan[parseInt(m, 10) - 1]}${y}`;
  };
  if (!dari && !sampai) return 'SemuaTanggal';
  if (dari && !sampai) return `Sejak-${compact(dari)}`;
  if (!dari && sampai) return `Sampai-${compact(sampai)}`;
  if (dari === sampai) return compact(dari);
  return `${compact(dari)}-${compact(sampai)}`;
}
