/**
 * sfx.js — the built-in SFX / Foley search panel.
 *
 * Searches Freesound's Creative Commons library, previews inline, and — the
 * point of the whole thing — lets you drag a result card straight onto the
 * timeline. No download-then-find-it-in-Explorer round trip.
 *
 * Freesound's API doesn't send CORS headers, so a static page can't call it
 * directly. Search and audio fetch both go through the small Cloudflare
 * Worker in /cloudflare-worker, which also keeps the API key server-side
 * instead of shipping it to every visitor. The Worker URL is configured once
 * and stored in IndexedDB.
 *
 * Drag payload: the custom MIME type `application/x-statevo-sfx`. The
 * timeline checks for that first and falls back to `dataTransfer.files`, so
 * dragging in from Explorer keeps working identically.
 */

import { esc, formatTime, debounce } from "../util.js";
import { getPref, setPref } from "../storage.js";

const QUICK_TAGS = [
  "footsteps", "door", "siren", "crowd chatter", "helicopter",
  "gunshot", "radio chatter", "applause", "traffic", "wind",
  "typing", "glass smash", "explosion", "room tone", "military",
];

const MAX_DURATION_OPTIONS = [
  { label: "any length", value: "" },
  { label: "≤ 5 s", value: "5" },
  { label: "≤ 15 s", value: "15" },
  { label: "≤ 30 s", value: "30" },
  { label: "≤ 2 min", value: "120" },
];

export class SfxPanel extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.proxyUrl = "";
    this.results = [];
    this.page = 1;
    this.query = "";
    this.total = 0;
    this.loading = false;
    this._audio = new Audio();
    this._audio.preload = "none";
    this._playingId = null;
    this._audio.addEventListener("ended", () => this._setPlaying(null));

    this._build();
    this._loadPrefs();
  }

  async _loadPrefs() {
    this.proxyUrl = (await getPref("sfxProxyUrl", "")) || "";
    this.safeOnly = (await getPref("sfxSafeOnly", true)) !== false;
    this.maxDuration = (await getPref("sfxMaxDuration", "")) || "";
    this._syncSettingsUi();
    this._renderStatus();
  }

  /* ------------------------------------------------------------------ */

  _build() {
    this.root.classList.add("sfx");
    this.root.innerHTML = `
      <div class="sfx-head">
        <h2>SFX &amp; Foley</h2>
        <button class="sfx-gear" title="Search source settings">⚙</button>
      </div>

      <div class="sfx-settings" hidden>
        <label class="sfx-field">
          <span>Freesound proxy URL</span>
          <input class="sfx-proxy" type="url" spellcheck="false"
                 placeholder="https://your-worker.workers.dev" />
        </label>
        <p class="sfx-hint">
          Freesound blocks direct browser calls, so search runs through a tiny
          Cloudflare Worker that holds your API key.
          <a href="https://github.com/phaser1980/VO-DAW/tree/main/cloudflare-worker"
             target="_blank" rel="noopener">Deploy instructions →</a>
        </p>
        <button class="sfx-test btn-ghost">Test connection</button>
        <div class="sfx-test-result"></div>
      </div>

      <div class="sfx-search">
        <input class="sfx-q" type="search" placeholder="boots on gravel, chopper hover…"
               spellcheck="false" />
        <button class="sfx-go" title="Search">→</button>
      </div>

      <div class="sfx-tags"></div>

      <div class="sfx-filters">
        <label class="sfx-check">
          <input type="checkbox" class="sfx-safe" checked />
          <span>Safe licence only</span>
        </label>
        <select class="sfx-dur">
          ${MAX_DURATION_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
        </select>
      </div>

      <div class="sfx-status"></div>
      <div class="sfx-results"></div>
      <div class="sfx-more" hidden><button class="btn-ghost sfx-more-btn">Load more</button></div>

      <div class="sfx-local">
        <label class="sfx-localdrop">
          <input type="file" class="sfx-file" accept="audio/*" multiple hidden />
          <span>or drop local audio here / <u>browse</u></span>
        </label>
      </div>
    `;

    this.qEl = this.root.querySelector(".sfx-q");
    this.tagsEl = this.root.querySelector(".sfx-tags");
    this.resultsEl = this.root.querySelector(".sfx-results");
    this.statusEl = this.root.querySelector(".sfx-status");
    this.moreEl = this.root.querySelector(".sfx-more");
    this.settingsEl = this.root.querySelector(".sfx-settings");
    this.proxyEl = this.root.querySelector(".sfx-proxy");
    this.safeEl = this.root.querySelector(".sfx-safe");
    this.durEl = this.root.querySelector(".sfx-dur");

    this.tagsEl.innerHTML = QUICK_TAGS.map(
      (t) => `<button class="sfx-tag" data-tag="${esc(t)}">${esc(t)}</button>`,
    ).join("");
    this.tagsEl.addEventListener("click", (e) => {
      const tag = e.target.dataset?.tag;
      if (!tag) return;
      this.qEl.value = tag;
      this.search(tag);
    });

    this.root.querySelector(".sfx-gear").addEventListener("click", () => {
      this.settingsEl.hidden = !this.settingsEl.hidden;
      if (!this.settingsEl.hidden) this.proxyEl.focus();
    });

    this.proxyEl.addEventListener("change", async () => {
      this.proxyUrl = this.proxyEl.value.trim().replace(/\/+$/, "");
      await setPref("sfxProxyUrl", this.proxyUrl);
      this._renderStatus();
    });

    this.root.querySelector(".sfx-test").addEventListener("click", () => this._testConnection());

    this.root.querySelector(".sfx-go").addEventListener("click", () => this.search(this.qEl.value));
    this.qEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.search(this.qEl.value);
      e.stopPropagation(); // don't let the timeline's space-to-play grab this
    });
    this.qEl.addEventListener("keyup", (e) => e.stopPropagation());

    this.safeEl.addEventListener("change", async () => {
      this.safeOnly = this.safeEl.checked;
      await setPref("sfxSafeOnly", this.safeOnly);
      if (this.query) this.search(this.query);
    });
    this.durEl.addEventListener("change", async () => {
      this.maxDuration = this.durEl.value;
      await setPref("sfxMaxDuration", this.maxDuration);
      if (this.query) this.search(this.query);
    });

    this.root.querySelector(".sfx-more-btn").addEventListener("click", () => this.loadMore());

    // Local files: browse or drop onto the panel's own drop strip.
    const fileInput = this.root.querySelector(".sfx-file");
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      if (files.length) this.dispatchEvent(new CustomEvent("localfiles", { detail: { files } }));
      fileInput.value = "";
    });
    const dropStrip = this.root.querySelector(".sfx-localdrop");
    ["dragover", "dragenter"].forEach((ev) =>
      dropStrip.addEventListener(ev, (e) => {
        e.preventDefault();
        dropStrip.classList.add("is-over");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropStrip.addEventListener(ev, () => dropStrip.classList.remove("is-over")),
    );
    dropStrip.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) this.dispatchEvent(new CustomEvent("localfiles", { detail: { files } }));
    });
  }

  _syncSettingsUi() {
    this.proxyEl.value = this.proxyUrl;
    this.safeEl.checked = this.safeOnly;
    this.durEl.value = this.maxDuration;
    if (!this.proxyUrl) this.settingsEl.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Network                                                             */
  /* ------------------------------------------------------------------ */

  get configured() {
    return !!this.proxyUrl;
  }

  async _testConnection() {
    const out = this.root.querySelector(".sfx-test-result");
    if (!this.proxyUrl) {
      out.textContent = "Enter a Worker URL first.";
      out.className = "sfx-test-result is-bad";
      return;
    }
    out.textContent = "Checking…";
    out.className = "sfx-test-result";
    try {
      const r = await fetch(`${this.proxyUrl}/health`, { method: "GET" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        out.textContent = j.hasKey
          ? "Connected — API key is set."
          : "Worker is up, but FREESOUND_API_KEY isn't set on it.";
        out.className = `sfx-test-result ${j.hasKey ? "is-good" : "is-bad"}`;
      } else {
        out.textContent = `Worker responded ${r.status}.`;
        out.className = "sfx-test-result is-bad";
      }
    } catch (err) {
      out.textContent = `Couldn't reach it: ${err.message}`;
      out.className = "sfx-test-result is-bad";
    }
  }

  async search(query, { append = false } = {}) {
    query = (query || "").trim();
    if (!query) return;
    if (!this.configured) {
      this.settingsEl.hidden = false;
      this._status("Set a Freesound proxy URL first — see the ⚙ settings above.", "warn");
      return;
    }

    this.query = query;
    if (!append) {
      this.page = 1;
      this.results = [];
      this.resultsEl.innerHTML = "";
    }

    this.loading = true;
    this._status(append ? "Loading more…" : `Searching “${query}”…`);

    const params = new URLSearchParams({
      q: query,
      page: String(this.page),
      safe: this.safeOnly ? "1" : "0",
    });
    if (this.maxDuration) params.set("max_duration", this.maxDuration);

    try {
      const res = await fetch(`${this.proxyUrl}/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Search failed (${res.status})`);

      this.total = data.count ?? 0;
      const fresh = (data.results || []).filter((r) => r.previews);
      this.results.push(...fresh);
      this._renderResults(fresh, append);

      if (!this.results.length) {
        this._status(
          `Nothing for “${query}”. Freesound matches keywords literally — try a plainer word (“gun” beats “firearm discharge”).`,
          "warn",
        );
      } else {
        this._status(`${this.results.length} of ${this.total} results`);
      }
      this.moreEl.hidden = this.results.length >= this.total;
    } catch (err) {
      this._status(`Search failed: ${err.message}`, "bad");
      this.moreEl.hidden = true;
    } finally {
      this.loading = false;
    }
  }

  loadMore() {
    if (this.loading) return;
    this.page += 1;
    this.search(this.query, { append: true });
  }

  /** Fetch a preview's bytes through the proxy so we can decode + import it. */
  async fetchSoundBytes(sound) {
    const url = this._previewUrl(sound);
    const res = await fetch(`${this.proxyUrl}/fetch?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`Could not fetch audio (${res.status})`);
    return res.arrayBuffer();
  }

  _previewUrl(sound) {
    const p = sound.previews || {};
    return p["preview-hq-mp3"] || p["preview-lq-mp3"] || p["preview-hq-ogg"] || p["preview-lq-ogg"];
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  _status(text, kind = "") {
    this.statusEl.textContent = text || "";
    this.statusEl.className = `sfx-status ${kind ? `is-${kind}` : ""}`;
  }

  _renderStatus() {
    if (!this.configured) {
      this._status("Search source not configured — open ⚙ to point it at your Worker.", "warn");
    } else if (!this.results.length && !this.query) {
      this._status("Search Freesound, or drop your own files at the bottom.");
    }
  }

  _renderResults(list, append) {
    const frag = document.createDocumentFragment();
    for (const s of list) frag.appendChild(this._card(s));
    if (!append) this.resultsEl.innerHTML = "";
    this.resultsEl.appendChild(frag);
  }

  _card(sound) {
    const el = document.createElement("div");
    el.className = "sfx-card";
    el.draggable = true;
    el.dataset.soundId = String(sound.id);

    const wave = sound.images?.waveform_m || "";
    const license = shortLicense(sound.license);

    el.innerHTML = `
      <div class="sfx-card-main">
        <button class="sfx-play" title="Preview">▶</button>
        <div class="sfx-card-txt">
          <div class="sfx-name" title="${esc(sound.name)}">${esc(sound.name)}</div>
          <div class="sfx-meta">
            <span>${formatTime(sound.duration || 0)}</span>
            <span class="sfx-lic ${license.cls}">${license.label}</span>
            <span class="sfx-user">${esc(sound.username || "")}</span>
          </div>
        </div>
        <button class="sfx-add" title="Add at playhead on the active track">+</button>
      </div>
      ${wave ? `<div class="sfx-wave"><img src="${esc(wave)}" alt="" loading="lazy" /></div>` : ""}
      <div class="sfx-drag-hint">drag onto the timeline</div>
    `;

    el.querySelector(".sfx-play").addEventListener("click", (e) => {
      e.stopPropagation();
      this._togglePreview(sound, el);
    });
    el.querySelector(".sfx-add").addEventListener("click", (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent("addsound", { detail: { sound } }));
    });

    el.addEventListener("dragstart", (e) => {
      const payload = {
        id: sound.id,
        name: sound.name,
        url: this._previewUrl(sound),
        duration: sound.duration,
        license: sound.license,
        username: sound.username,
      };
      e.dataTransfer.setData("application/x-statevo-sfx", JSON.stringify(payload));
      // Plain-text fallback so dropping onto a text field does something sane.
      e.dataTransfer.setData("text/plain", `${sound.name} — freesound.org/s/${sound.id}/`);
      e.dataTransfer.effectAllowed = "copy";
      el.classList.add("is-dragging");
      this.dispatchEvent(new CustomEvent("dragstart-sound", { detail: { sound } }));
    });
    el.addEventListener("dragend", () => el.classList.remove("is-dragging"));

    return el;
  }

  _togglePreview(sound, el) {
    const url = this._previewUrl(sound);
    if (this._playingId === sound.id) {
      this._audio.pause();
      this._setPlaying(null);
      return;
    }
    this._audio.src = url;
    this._audio.play().catch(() => {
      this._status("Preview blocked by the browser — click anywhere first, then retry.", "warn");
    });
    this._setPlaying(sound.id);
  }

  _setPlaying(id) {
    this._playingId = id;
    this.resultsEl.querySelectorAll(".sfx-card").forEach((c) => {
      const on = c.dataset.soundId === String(id);
      c.classList.toggle("is-playing", on);
      const btn = c.querySelector(".sfx-play");
      if (btn) btn.textContent = on ? "❚❚" : "▶";
    });
  }

  stopPreview() {
    this._audio.pause();
    this._setPlaying(null);
  }
}

function shortLicense(url = "") {
  const u = String(url).toLowerCase();
  if (u.includes("publicdomain") || u.includes("zero")) return { label: "CC0", cls: "is-cc0" };
  if (u.includes("by-nc")) return { label: "BY-NC", cls: "is-nc" };
  if (u.includes("/by/")) return { label: "BY", cls: "is-by" };
  if (u.includes("sampling")) return { label: "Sampling+", cls: "is-nc" };
  return { label: "see licence", cls: "" };
}
