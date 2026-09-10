/**
 * util.js — small helpers shared across StateVO Web.
 * No DOM assumptions beyond what's noted; safe to import anywhere.
 */

/** Short, collision-resistant-enough id for clips/tracks/takes. */
export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(g) {
  return 20 * Math.log10(Math.max(g, 1e-9));
}

/** 12.345 -> "0:12.3" ; used for the transport clock and clip labels. */
export function formatTime(sec, withMs = true) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const t = Math.floor((sec - Math.floor(sec)) * 10);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return (neg ? "-" : "") + (withMs ? `${base}.${t}` : base);
}

/** "-14.2 LUFS" style, tolerant of -Infinity (digital silence). */
export function formatDb(v, digits = 1) {
  if (v === null || v === undefined || !isFinite(v)) return "−∞";
  return v.toFixed(digits);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** YYYY-MM-DD in local time — used for export auto-naming. */
export function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Strip anything a filesystem would object to. */
export function safeFilename(s) {
  return (s || "untitled")
    .replace(/[^\w\-. ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

export function debounce(fn, ms = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Fire `fn` at most once per animation frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/** Structured deep clone with a JSON fallback for older engines. */
export function deepClone(obj) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(obj);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late — Safari needs the URL alive past the click.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Read a File/Blob as ArrayBuffer. */
export function readAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

export function readAsText(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

/** Escape for safe innerHTML interpolation. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
