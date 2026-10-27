// Small shared helpers for 万事通.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function uid(prefix = '') {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function safeJSON(text, fallback = {}) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// Money: OpenRouter reports cost in USD.
export function fmtUSD(n) {
  if (n == null || isNaN(n)) return '';
  if (n === 0) return 'US$0';
  if (n < 0.0001) return '< US$0.0001';
  if (n < 0.01) return 'US$' + n.toFixed(4);
  if (n < 1) return 'US$' + n.toFixed(3);
  return 'US$' + n.toFixed(2);
}

export function fmtDuration(ms) {
  if (!ms) return '';
  const s = ms / 1000;
  return s < 10 ? s.toFixed(1) + ' 秒' : Math.round(s) + ' 秒';
}

export function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function relTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  const diff = (now - d) / 86400000;
  if (diff < 7) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const isB64 = head.includes(';base64');
  const raw = isB64 ? atob(body) : decodeURIComponent(body);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function extFromMime(mime) {
  if (!mime) return 'png';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

// Save or share an image. On phones, sharing a File lets the user tap "Save Image".
export async function saveImage(dataUrl, baseName = 'wanshitong') {
  const blob = dataUrlToBlob(dataUrl);
  const name = `${baseName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${extFromMime(blob.type)}`;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Load a classic (UMD) script once, e.g. mammoth or SheetJS.
const scriptCache = new Map();
export function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptCache.delete(src);
      reject(new Error('载入组件失败：' + src));
    };
    document.head.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}
