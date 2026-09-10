/**
 * toast.js — transient status messages and a blocking progress overlay.
 * Small on purpose: a DAW that interrupts you with modal dialogs for
 * "imported 3 files" is a DAW you stop using.
 */

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "toasts";
  document.body.appendChild(host);
  return host;
}

export function toast(message, kind = "info", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  ensureHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-in"));
  setTimeout(() => {
    el.classList.remove("is-in");
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

export const toastError = (m) => toast(m, "error", 6000);
export const toastOk = (m) => toast(m, "ok");

/** Returns a handle with update(p, label) and close(). */
export function progressOverlay(title) {
  const el = document.createElement("div");
  el.className = "overlay";
  el.innerHTML = `
    <div class="overlay-card">
      <h3>${title}</h3>
      <div class="overlay-bar"><div class="overlay-fill"></div></div>
      <div class="overlay-label">Starting…</div>
    </div>`;
  document.body.appendChild(el);
  const fill = el.querySelector(".overlay-fill");
  const label = el.querySelector(".overlay-label");
  return {
    update(p, text) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
      if (text) label.textContent = text;
    },
    close() {
      el.remove();
    },
  };
}

/** Minimal promise-based confirm, so we're not using window.confirm. */
export function confirmDialog(title, body, { okLabel = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "overlay";
    el.innerHTML = `
      <div class="overlay-card">
        <h3>${title}</h3>
        <p class="overlay-body">${body}</p>
        <div class="overlay-actions">
          <button class="btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? "btn-danger" : ""}" data-act="ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      el.remove();
      resolve(act === "ok");
    });
  });
}

/** Minimal promise-based prompt. */
export function promptDialog(title, { value = "", placeholder = "", okLabel = "Save" } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "overlay";
    el.innerHTML = `
      <div class="overlay-card">
        <h3>${title}</h3>
        <input class="overlay-input" value="${String(value).replace(/"/g, "&quot;")}"
               placeholder="${placeholder}" />
        <div class="overlay-actions">
          <button class="btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn" data-act="ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const input = el.querySelector(".overlay-input");
    input.focus();
    input.select();
    const finish = (ok) => {
      const v = input.value;
      el.remove();
      resolve(ok ? v : null);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    el.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (act) finish(act === "ok");
    });
  });
}
