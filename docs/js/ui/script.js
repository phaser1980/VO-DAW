/**
 * script.js — script import, markers, and the teleprompter.
 *
 * Three tabs sharing one panel because they're the same job seen three ways:
 * the words you're going to read, the points in time those words landed, and
 * a big-type view that scrolls while you read.
 *
 * Section parsing accepts markdown headings (`#`, `##`), bracketed cues
 * (`[VOX]`, `[SFX: door]`), ALL-CAPS speaker labels, and falls back to blank
 * -line-separated paragraphs — which covers every way a parody script
 * actually arrives.
 */

import { esc, formatTime, readAsText } from "../util.js";
import { makeMarker } from "../model.js";

export class ScriptPanel extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.project = null;
    this.tab = "script";
    this.followPlayback = true;
    this._activeSectionIdx = -1;
    this._build();
  }

  setProject(project) {
    this.project = project;
    this.root.querySelector(".sp-text").value = project.script?.text || "";
    this.renderSections();
    this.renderMarkers();
    this.renderPrompter();
  }

  /* ------------------------------------------------------------------ */

  _build() {
    this.root.classList.add("sp");
    this.root.innerHTML = `
      <div class="sp-tabs">
        <button class="sp-tab is-on" data-tab="script">Script</button>
        <button class="sp-tab" data-tab="markers">Markers</button>
        <button class="sp-tab" data-tab="prompter">Prompter</button>
      </div>

      <section class="sp-pane" data-pane="script">
        <div class="sp-row">
          <label class="btn-ghost sp-import">
            Import .txt / .md
            <input type="file" accept=".txt,.md,.markdown,text/plain" hidden />
          </label>
          <button class="btn-ghost sp-parse">Find sections</button>
        </div>
        <textarea class="sp-text" spellcheck="false"
          placeholder="Paste your script here, or import a .txt / .md file.

# Cold open
Good evening, and welcome to the Absolute State.

# Story one
..."></textarea>
        <div class="sp-sections"></div>
      </section>

      <section class="sp-pane" data-pane="markers" hidden>
        <div class="sp-row">
          <button class="btn-ghost sp-addmarker">+ Marker at playhead</button>
          <button class="btn-ghost sp-clearmarkers">Clear all</button>
        </div>
        <div class="sp-markers"></div>
      </section>

      <section class="sp-pane" data-pane="prompter" hidden>
        <div class="sp-row sp-prompter-ctl">
          <label class="sfx-check">
            <input type="checkbox" class="sp-follow" checked />
            <span>Scroll with playback</span>
          </label>
          <div class="sp-fontsize">
            <button data-size="-">A−</button><button data-size="+">A+</button>
          </div>
        </div>
        <div class="sp-prompter"></div>
      </section>
    `;

    this.root.querySelector(".sp-tabs").addEventListener("click", (e) => {
      const tab = e.target.dataset?.tab;
      if (!tab) return;
      this.tab = tab;
      this.root.querySelectorAll(".sp-tab").forEach((b) =>
        b.classList.toggle("is-on", b.dataset.tab === tab),
      );
      this.root.querySelectorAll(".sp-pane").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    });

    const textEl = this.root.querySelector(".sp-text");
    textEl.addEventListener("input", () => {
      if (!this.project) return;
      this.project.script.text = textEl.value;
      this._changed("script text");
    });
    textEl.addEventListener("keydown", (e) => e.stopPropagation());
    textEl.addEventListener("keyup", (e) => e.stopPropagation());

    this.root.querySelector(".sp-import input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await readAsText(file);
      textEl.value = text;
      this.project.script.text = text;
      this.parseSections();
      this._changed("script import");
      e.target.value = "";
    });

    this.root.querySelector(".sp-parse").addEventListener("click", () => this.parseSections());

    this.root.querySelector(".sp-addmarker").addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("addmarker")),
    );
    this.root.querySelector(".sp-clearmarkers").addEventListener("click", () => {
      if (!this.project?.markers.length) return;
      this.project.markers = [];
      this.renderMarkers();
      this._changed("clear markers");
    });

    this.root.querySelector(".sp-follow").addEventListener("change", (e) => {
      this.followPlayback = e.target.checked;
    });
    this.root.querySelector(".sp-fontsize").addEventListener("click", (e) => {
      const dir = e.target.dataset?.size;
      if (!dir) return;
      const el = this.root.querySelector(".sp-prompter");
      const cur = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = `${Math.max(13, Math.min(46, cur + (dir === "+" ? 3 : -3)))}px`;
    });
  }

  _changed(reason) {
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  /* ------------------------------------------------------------------ */
  /* Sections                                                            */
  /* ------------------------------------------------------------------ */

  parseSections() {
    if (!this.project) return [];
    const sections = parseScript(this.project.script.text || "");
    this.project.script.sections = sections;
    this.renderSections();
    this.renderPrompter();
    this._changed("parse sections");
    return sections;
  }

  renderSections() {
    const host = this.root.querySelector(".sp-sections");
    const sections = this.project?.script?.sections || [];
    if (!sections.length) {
      host.innerHTML = `<p class="sp-empty">No sections yet — hit <b>Find sections</b> and each heading becomes a marker you can drop at the playhead.</p>`;
      return;
    }
    host.innerHTML = `
      <div class="sp-row sp-sections-head">
        <span>${sections.length} section${sections.length === 1 ? "" : "s"}</span>
        <button class="btn-ghost sp-markall">Markers, spaced evenly</button>
      </div>
      ${sections
        .map(
          (s, i) => `
        <div class="sp-section" data-idx="${i}">
          <button class="sp-sec-place" title="Put a marker here at the playhead">◎</button>
          <div class="sp-sec-body">
            <div class="sp-sec-title">${esc(s.title)}</div>
            <div class="sp-sec-preview">${esc(s.body.slice(0, 110))}${s.body.length > 110 ? "…" : ""}</div>
          </div>
        </div>`,
        )
        .join("")}
    `;

    host.querySelector(".sp-markall")?.addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("markersfromsections")),
    );
    host.querySelectorAll(".sp-section").forEach((el) => {
      el.querySelector(".sp-sec-place").addEventListener("click", () => {
        const idx = Number(el.dataset.idx);
        this.dispatchEvent(
          new CustomEvent("placesection", { detail: { section: sections[idx], index: idx } }),
        );
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Markers                                                             */
  /* ------------------------------------------------------------------ */

  renderMarkers() {
    const host = this.root.querySelector(".sp-markers");
    const markers = [...(this.project?.markers || [])].sort((a, b) => a.timeSec - b.timeSec);
    if (!markers.length) {
      host.innerHTML = `<p class="sp-empty">No markers. <b>M</b> drops one at the playhead.</p>`;
      return;
    }
    host.innerHTML = markers
      .map(
        (m) => `
      <div class="sp-marker" data-id="${m.id}">
        <button class="sp-mk-time">${formatTime(m.timeSec)}</button>
        <input class="sp-mk-label" value="${esc(m.label)}" spellcheck="false" />
        <button class="sp-mk-del" title="Delete">✕</button>
      </div>`,
      )
      .join("");

    host.querySelectorAll(".sp-marker").forEach((el) => {
      const id = el.dataset.id;
      const marker = markers.find((m) => m.id === id);
      el.querySelector(".sp-mk-time").addEventListener("click", () =>
        this.dispatchEvent(new CustomEvent("seek", { detail: { sec: marker.timeSec } })),
      );
      el.querySelector(".sp-mk-label").addEventListener("change", (e) => {
        marker.label = e.target.value;
        this._changed("rename marker");
      });
      el.querySelector(".sp-mk-label").addEventListener("keydown", (e) => e.stopPropagation());
      el.querySelector(".sp-mk-del").addEventListener("click", () => {
        this.project.markers = this.project.markers.filter((m) => m.id !== id);
        this.renderMarkers();
        this._changed("delete marker");
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Teleprompter                                                        */
  /* ------------------------------------------------------------------ */

  renderPrompter() {
    const host = this.root.querySelector(".sp-prompter");
    const sections = this.project?.script?.sections || [];
    if (!sections.length) {
      const text = this.project?.script?.text || "";
      host.innerHTML = text
        ? `<div class="sp-prompter-block">${esc(text).replace(/\n/g, "<br>")}</div>`
        : `<p class="sp-empty">Import or paste a script to use the prompter.</p>`;
      return;
    }
    host.innerHTML = sections
      .map(
        (s, i) => `
      <div class="sp-prompter-block" data-idx="${i}">
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.body).replace(/\n/g, "<br>")}</p>
      </div>`,
      )
      .join("");
  }

  /**
   * Called from the transport tick. Highlights whichever section the playhead
   * has reached, using markers as the mapping between time and script.
   */
  syncToTime(sec) {
    if (this.tab !== "prompter" || !this.followPlayback) return;
    const markers = [...(this.project?.markers || [])].sort((a, b) => a.timeSec - b.timeSec);
    if (!markers.length) return;

    let idx = -1;
    for (let i = 0; i < markers.length; i++) if (markers[i].timeSec <= sec + 0.05) idx = i;
    if (idx === this._activeSectionIdx) return;
    this._activeSectionIdx = idx;

    const host = this.root.querySelector(".sp-prompter");
    const blocks = host.querySelectorAll(".sp-prompter-block");
    blocks.forEach((b, i) => b.classList.toggle("is-current", i === idx));
    const target = blocks[idx];
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * @returns {{title: string, body: string, line: number}[]}
 */
export function parseScript(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let current = null;

  const isHeading = (l) => {
    const t = l.trim();
    if (!t) return null;
    let m = t.match(/^#{1,6}\s+(.*)$/); // # markdown heading
    if (m) return m[1].trim();
    m = t.match(/^\[([^\]]{1,60})\]\s*:?\s*$/); // [COLD OPEN]
    if (m) return m[1].trim();
    m = t.match(/^([A-Z][A-Z0-9 '/&.-]{2,40}):\s*$/); // NEWSREADER:
    if (m) return m[1].trim();
    m = t.match(/^-{3,}\s*(.+?)\s*-{3,}$/); // --- scene ---
    if (m) return m[1].trim();
    return null;
  };

  lines.forEach((line, i) => {
    const heading = isHeading(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading, body: "", line: i };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else if (line.trim()) {
      current = { title: line.trim().slice(0, 48), body: "", line: i };
    }
  });
  if (current) sections.push(current);

  // No headings at all — fall back to blank-line-separated paragraphs.
  if (sections.length <= 1 && text.trim()) {
    const paras = String(text).split(/\n\s*\n/).filter((p) => p.trim());
    if (paras.length > 1) {
      return paras.map((p, i) => {
        const firstLine = p.trim().split("\n")[0];
        return {
          title: firstLine.slice(0, 48) + (firstLine.length > 48 ? "…" : ""),
          body: p.trim(),
          line: i,
        };
      });
    }
  }

  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

/** Spread one marker per section evenly across `durationSec`. */
export function markersFromSections(sections, durationSec) {
  if (!sections.length) return [];
  const span = Math.max(durationSec, sections.length * 2);
  return sections.map((s, i) =>
    makeMarker({ timeSec: (i * span) / sections.length, label: s.title }),
  );
}
