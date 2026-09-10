/**
 * timeline.js — the multi-track canvas timeline.
 *
 * One canvas draws every lane; a DOM column to its left holds the track
 * headers (name, mute, solo, collapse) because those want real buttons and
 * real focus behaviour, not hit-tested rectangles.
 *
 * What lives here:
 *   - coordinate mapping (time <-> pixels) and zoom/scroll
 *   - clip drawing from the peak cache
 *   - mouse editing: move, trim from either edge, fade handles, selection
 *   - drag-and-drop landing logic, for both OS files and SFX panel cards
 *
 * What deliberately doesn't: anything that touches audio. The timeline
 * mutates the project model and emits a "change" event; the app decides
 * what that means.
 */

import { clamp, formatTime, uid } from "../util.js";
import { clipDuration, clipEnd, makeClip, makeTrack, sortClips, TrackKind } from "../model.js";
import { readPeaks } from "../audio/peaks.js";

const HEAD_W = 170;
const LANE_H = 104;
const LANE_H_COLLAPSED = 34;
const RULER_H = 30;
const ADD_LANE_H = 34;
const EDGE_GRAB_PX = 7;
const FADE_HANDLE_PX = 11;

const COLORS = {
  bg: "#12151b",
  lane: "#171b23",
  laneAlt: "#151922",
  laneActive: "#1b212c",
  grid: "#232936",
  gridStrong: "#2e3644",
  clipVoice: "#1f6f8b",
  clipVoiceBody: "#20313d",
  clipSfx: "#8a6320",
  clipSfxBody: "#3a2f1c",
  wave: "#7fd4ef",
  waveSfx: "#f0c274",
  clipSelected: "#e9eef5",
  text: "#c7cfdb",
  textDim: "#7b8697",
  playhead: "#ff4d4d",
  selection: "rgba(87,199,255,0.14)",
  selectionEdge: "#57c7ff",
  marker: "#e8a33d",
  dropTarget: "rgba(87,199,255,0.16)",
  dropTargetNew: "rgba(232,163,61,0.18)",
};

export class Timeline extends EventTarget {
  /**
   * @param {HTMLElement} root  container element
   * @param {{getCache: (takeId:string)=>any}} deps
   */
  constructor(root, deps) {
    super();
    this.root = root;
    this.getCache = deps.getCache;
    this.project = null;

    this.pxPerSec = 90;
    this.scrollSec = 0;
    this.playheadSec = 0;
    this.selection = null; // {startSec, endSec}
    this.activeTrackId = null;
    this.selectedClipId = null;
    this.snap = true;
    this.snapSec = 0.05;

    this._drag = null;
    this._dropHint = null;
    this._buildDom();
    this._bind();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.root);
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  _buildDom() {
    this.root.classList.add("tl");
    this.root.innerHTML = `
      <div class="tl-rulerrow">
        <div class="tl-corner">
          <button class="tl-zoom" data-zoom="out" title="Zoom out (−)">−</button>
          <button class="tl-zoom" data-zoom="in" title="Zoom in (+)">+</button>
          <button class="tl-zoom tl-zoom-fit" data-zoom="fit" title="Fit project">fit</button>
        </div>
        <canvas class="tl-ruler"></canvas>
      </div>
      <div class="tl-scroll">
        <div class="tl-body">
          <div class="tl-heads"></div>
          <canvas class="tl-canvas" tabindex="0"></canvas>
        </div>
      </div>
      <div class="tl-hscroll"><div class="tl-hscroll-inner"></div></div>
    `;
    this.rulerCanvas = this.root.querySelector(".tl-ruler");
    this.canvas = this.root.querySelector(".tl-canvas");
    this.heads = this.root.querySelector(".tl-heads");
    this.scroller = this.root.querySelector(".tl-scroll");
    this.hscroll = this.root.querySelector(".tl-hscroll");
    this.hscrollInner = this.root.querySelector(".tl-hscroll-inner");
    this.ctx = this.canvas.getContext("2d");
    this.rulerCtx = this.rulerCanvas.getContext("2d");
  }

  _bind() {
    this.canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
    window.addEventListener("mousemove", (e) => this._onMouseMove(e));
    window.addEventListener("mouseup", (e) => this._onMouseUp(e));
    this.canvas.addEventListener("dblclick", (e) => this._onDoubleClick(e));
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.rulerCanvas.addEventListener("mousedown", (e) => this._onRulerDown(e));
    this.rulerCanvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

    this.hscroll.addEventListener("scroll", () => {
      if (this._syncingScroll) return;
      this.scrollSec = this.hscroll.scrollLeft / this.pxPerSec;
      this.draw();
    });

    this.root.querySelector(".tl-corner").addEventListener("click", (e) => {
      const z = e.target.dataset.zoom;
      if (z === "in") this.zoom(1.35);
      else if (z === "out") this.zoom(1 / 1.35);
      else if (z === "fit") this.zoomToFit();
    });

    // Drag & drop — files from the OS, or cards from the SFX panel.
    const dropZone = this.root.querySelector(".tl-scroll");
    dropZone.addEventListener("dragover", (e) => this._onDragOver(e));
    dropZone.addEventListener("dragleave", (e) => this._onDragLeave(e));
    dropZone.addEventListener("drop", (e) => this._onDrop(e));
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                              */
  /* ------------------------------------------------------------------ */

  setProject(project) {
    this.project = project;
    this.pxPerSec = project.view?.pxPerSec || 90;
    this.scrollSec = project.view?.scrollSec || 0;
    this.playheadSec = project.view?.playheadSec || 0;
    this.activeTrackId = project.tracks[0]?.id || null;
    this.selectedClipId = null;
    this.selection = null;
    this.renderHeads();
    this.resize();
  }

  trackHeight(track) {
    return track.collapsed ? LANE_H_COLLAPSED : LANE_H;
  }

  /** Cumulative y offset of each lane, plus the "+ new track" row. */
  layout() {
    const rows = [];
    let y = 0;
    for (const t of this.project?.tracks || []) {
      const h = this.trackHeight(t);
      rows.push({ track: t, y, h });
      y += h;
    }
    return { rows, contentH: y + ADD_LANE_H, addY: y };
  }

  resize() {
    if (!this.project) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, this.root.clientWidth - HEAD_W);
    const { contentH } = this.layout();
    const h = Math.max(120, contentH);

    for (const [cv, cw, ch] of [
      [this.canvas, w, h],
      [this.rulerCanvas, w, RULER_H],
    ]) {
      cv.width = Math.floor(cw * dpr);
      cv.height = Math.floor(ch * dpr);
      cv.style.width = `${cw}px`;
      cv.style.height = `${ch}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;

    this.heads.style.width = `${HEAD_W}px`;
    this._syncHScroll();
    this.draw();
  }

  get viewSec() {
    return (this.viewW || 800) / this.pxPerSec;
  }

  timeToX(t) {
    return (t - this.scrollSec) * this.pxPerSec;
  }

  xToTime(x) {
    return this.scrollSec + x / this.pxPerSec;
  }

  _syncHScroll() {
    const total = Math.max(this.contentDuration() + 5, this.viewSec + 5);
    this.hscrollInner.style.width = `${total * this.pxPerSec}px`;
    this._syncingScroll = true;
    this.hscroll.scrollLeft = this.scrollSec * this.pxPerSec;
    requestAnimationFrame(() => (this._syncingScroll = false));
  }

  contentDuration() {
    if (!this.project) return 0;
    let m = 0;
    for (const t of this.project.tracks) for (const c of t.clips) m = Math.max(m, clipEnd(c));
    return m;
  }

  zoom(factor, anchorSec = null) {
    const anchor = anchorSec ?? this.playheadSec;
    const before = this.timeToX(anchor);
    this.pxPerSec = clamp(this.pxPerSec * factor, 2, 2000);
    this.scrollSec = Math.max(0, anchor - before / this.pxPerSec);
    this._persistView();
    this._syncHScroll();
    this.draw();
  }

  zoomToFit() {
    const dur = this.contentDuration();
    if (dur <= 0) return;
    this.pxPerSec = clamp((this.viewW - 24) / dur, 2, 2000);
    this.scrollSec = 0;
    this._persistView();
    this._syncHScroll();
    this.draw();
  }

  scrollTo(sec) {
    this.scrollSec = Math.max(0, sec);
    this._persistView();
    this._syncHScroll();
    this.draw();
  }

  /** Keep the playhead on screen during playback. */
  followPlayhead() {
    const x = this.timeToX(this.playheadSec);
    if (x > this.viewW * 0.82 || x < 0) {
      this.scrollTo(this.playheadSec - this.viewSec * 0.25);
    }
  }

  _persistView() {
    if (!this.project) return;
    this.project.view = {
      pxPerSec: this.pxPerSec,
      scrollSec: this.scrollSec,
      playheadSec: this.playheadSec,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Track headers                                                       */
  /* ------------------------------------------------------------------ */

  renderHeads() {
    if (!this.project) return;
    const { rows, addY } = this.layout();
    this.heads.innerHTML = "";

    for (const { track, h } of rows) {
      const el = document.createElement("div");
      el.className = "tl-head" + (track.id === this.activeTrackId ? " is-active" : "");
      el.style.height = `${h}px`;
      el.dataset.trackId = track.id;
      el.innerHTML = `
        <div class="tl-head-top">
          <button class="tl-collapse" title="${track.collapsed ? "Expand" : "Collapse"}">${track.collapsed ? "▸" : "▾"}</button>
          <input class="tl-head-name" value="${track.name.replace(/"/g, "&quot;")}" spellcheck="false" />
        </div>
        <div class="tl-head-btns">
          <button class="tl-tbtn ${track.muted ? "on-m" : ""}" data-act="mute" title="Mute">M</button>
          <button class="tl-tbtn ${track.solo ? "on-s" : ""}" data-act="solo" title="Solo">S</button>
          <span class="tl-head-kind">${track.kind === TrackKind.VOICE ? "voice" : "sfx"}</span>
          <button class="tl-tbtn tl-tbtn-x" data-act="remove" title="Delete track">✕</button>
        </div>
      `;
      el.addEventListener("mousedown", () => this.setActiveTrack(track.id));
      el.querySelector(".tl-collapse").addEventListener("click", (e) => {
        e.stopPropagation();
        track.collapsed = !track.collapsed;
        this._changed("track collapse");
        this.renderHeads();
        this.resize();
      });
      el.querySelector(".tl-head-name").addEventListener("change", (e) => {
        track.name = e.target.value.trim() || track.name;
        this._changed("rename track");
      });
      el.querySelectorAll("[data-act]").forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = b.dataset.act;
          if (act === "mute") track.muted = !track.muted;
          else if (act === "solo") track.solo = !track.solo;
          else if (act === "remove") {
            if (this.project.tracks.length <= 1) return;
            this.project.tracks = this.project.tracks.filter((t) => t.id !== track.id);
            if (this.activeTrackId === track.id)
              this.activeTrackId = this.project.tracks[0]?.id || null;
          }
          this._changed(`track ${act}`);
          this.renderHeads();
          this.resize();
        }),
      );
      this.heads.appendChild(el);
    }

    const add = document.createElement("div");
    add.className = "tl-head tl-head-add";
    add.style.height = `${ADD_LANE_H}px`;
    add.textContent = "+ New track";
    add.addEventListener("click", () => this.addTrack());
    this.heads.appendChild(add);
    this.heads.style.height = `${addY + ADD_LANE_H}px`;
  }

  addTrack(name = null, kind = TrackKind.SFX) {
    const n = this.project.tracks.filter((t) => t.kind === kind).length + 1;
    const track = makeTrack({ name: name || (kind === TrackKind.VOICE ? `Voice ${n}` : `SFX ${n}`), kind });
    this.project.tracks.push(track);
    this.activeTrackId = track.id;
    this._changed("add track");
    this.renderHeads();
    this.resize();
    return track;
  }

  setActiveTrack(id) {
    if (this.activeTrackId === id) return;
    this.activeTrackId = id;
    this.renderHeads();
    this.draw();
    this.dispatchEvent(new CustomEvent("activetrack", { detail: { trackId: id } }));
  }

  get activeTrack() {
    return this.project?.tracks.find((t) => t.id === this.activeTrackId) || this.project?.tracks[0];
  }

  /* ------------------------------------------------------------------ */
  /* Hit testing                                                         */
  /* ------------------------------------------------------------------ */

  _localPos(e, el = this.canvas) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Which lane is at canvas-y? Returns null past the last lane. */
  laneAt(y) {
    const { rows } = this.layout();
    for (const row of rows) if (y >= row.y && y < row.y + row.h) return row;
    return null;
  }

  /**
   * Full hit test at a canvas point.
   * @returns {{row, clip, region}} region: 'body'|'trim-in'|'trim-out'|'fade-in'|'fade-out'|'empty'
   */
  hitTest(x, y) {
    const row = this.laneAt(y);
    if (!row) return { row: null, clip: null, region: "outside" };
    const t = this.xToTime(x);
    for (const clip of row.track.clips) {
      const x0 = this.timeToX(clip.startSec);
      const x1 = this.timeToX(clipEnd(clip));
      if (x < x0 - 2 || x > x1 + 2) continue;

      if (!row.track.collapsed) {
        const topBand = y - row.y < FADE_HANDLE_PX + 14;
        if (topBand && x - x0 < Math.max(FADE_HANDLE_PX, this.timeToX(clip.startSec + clip.fadeInSec) - x0))
          return { row, clip, region: "fade-in" };
        if (topBand && x1 - x < Math.max(FADE_HANDLE_PX, x1 - this.timeToX(clipEnd(clip) - clip.fadeOutSec)))
          return { row, clip, region: "fade-out" };
      }
      if (x - x0 <= EDGE_GRAB_PX) return { row, clip, region: "trim-in" };
      if (x1 - x <= EDGE_GRAB_PX) return { row, clip, region: "trim-out" };
      return { row, clip, region: "body" };
    }
    return { row, clip: null, region: "empty", timeSec: t };
  }

  _snap(t) {
    if (!this.snap) return Math.max(0, t);
    // Snap to a grid, but also to nearby clip edges and markers — that's the
    // one that actually matters when you're butting an SFX up to a word.
    const candidates = [Math.round(t / this.snapSec) * this.snapSec, this.playheadSec];
    for (const track of this.project.tracks) {
      for (const c of track.clips) {
        candidates.push(c.startSec, clipEnd(c));
      }
    }
    for (const m of this.project.markers) candidates.push(m.timeSec);

    const tolSec = 8 / this.pxPerSec;
    let best = Math.max(0, t);
    let bestD = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestD && d <= tolSec) {
        bestD = d;
        best = c;
      }
    }
    return Math.max(0, best);
  }

  /* ------------------------------------------------------------------ */
  /* Mouse                                                               */
  /* ------------------------------------------------------------------ */

  _onRulerDown(e) {
    const { x } = this._localPos(e, this.rulerCanvas);
    const t = Math.max(0, this.xToTime(x));
    this.setPlayhead(t, true);
    this._drag = { kind: "scrub" };
  }

  _onMouseDown(e) {
    if (!this.project) return;
    this.canvas.focus();
    const { x, y } = this._localPos(e);
    const { rows, addY } = this.layout();

    if (y >= addY) {
      this.addTrack();
      return;
    }

    const hit = this.hitTest(x, y);
    if (hit.row) this.setActiveTrack(hit.row.track.id);

    const t = this.xToTime(x);

    if (hit.clip && hit.region !== "empty") {
      this.selectedClipId = hit.clip.id;
      this.dispatchEvent(
        new CustomEvent("clipselect", { detail: { clip: hit.clip, track: hit.row.track } }),
      );
      this._drag = {
        kind: hit.region,
        clip: hit.clip,
        track: hit.row.track,
        grabOffset: t - hit.clip.startSec,
        orig: { ...hit.clip },
        startY: y,
      };
      this.draw();
      return;
    }

    // Empty lane: playhead + time selection drag.
    this.selectedClipId = null;
    const st = this._snap(t);
    this.setPlayhead(st, true);
    this.selection = null;
    this._drag = { kind: "select", anchorSec: st };
    this.draw();
  }

  _onMouseMove(e) {
    if (!this.project) return;
    const { x, y } = this._localPos(e);

    if (!this._drag) {
      // Cursor affordance
      const hit = this.hitTest(x, y);
      let cursor = "default";
      if (hit.region === "trim-in" || hit.region === "trim-out") cursor = "ew-resize";
      else if (hit.region === "fade-in" || hit.region === "fade-out") cursor = "nesw-resize";
      else if (hit.region === "body") cursor = "grab";
      this.canvas.style.cursor = cursor;
      return;
    }

    const t = this.xToTime(x);
    const d = this._drag;

    if (d.kind === "scrub") {
      this.setPlayhead(Math.max(0, t), true);
      return;
    }

    if (d.kind === "select") {
      const st = this._snap(t);
      this.selection = {
        startSec: Math.min(d.anchorSec, st),
        endSec: Math.max(d.anchorSec, st),
      };
      if (this.selection.endSec - this.selection.startSec < 0.001) this.selection = null;
      this.draw();
      return;
    }

    if (d.kind === "body") {
      const newStart = this._snap(t - d.grabOffset);
      d.clip.startSec = Math.max(0, newStart);

      // Vertical drag across lanes moves the clip to another track.
      const row = this.laneAt(y);
      if (row && row.track.id !== d.track.id) {
        d.track.clips = d.track.clips.filter((c) => c.id !== d.clip.id);
        row.track.clips.push(d.clip);
        sortClips(row.track);
        d.track = row.track;
        this.setActiveTrack(row.track.id);
      }
      sortClips(d.track);
      this.canvas.style.cursor = "grabbing";
      this.draw();
      return;
    }

    if (d.kind === "trim-in") {
      const maxIn = d.orig.sourceOutSec - 0.02;
      const deltaT = this._snap(t) - d.orig.startSec;
      const newSourceIn = clamp(d.orig.sourceInSec + deltaT, 0, maxIn);
      const applied = newSourceIn - d.orig.sourceInSec;
      d.clip.sourceInSec = newSourceIn;
      d.clip.startSec = Math.max(0, d.orig.startSec + applied);
      d.clip.fadeInSec = Math.min(d.clip.fadeInSec, clipDuration(d.clip) / 2);
      this.draw();
      return;
    }

    if (d.kind === "trim-out") {
      const cached = this.getCache(d.clip.takeId);
      const takeDur = cached?.buffer?.duration ?? d.orig.sourceOutSec;
      const wanted = this._snap(t) - d.orig.startSec + d.orig.sourceInSec;
      d.clip.sourceOutSec = clamp(wanted, d.clip.sourceInSec + 0.02, takeDur);
      d.clip.fadeOutSec = Math.min(d.clip.fadeOutSec, clipDuration(d.clip) / 2);
      this.draw();
      return;
    }

    if (d.kind === "fade-in") {
      d.clip.fadeInSec = clamp(t - d.clip.startSec, 0, clipDuration(d.clip) * 0.98);
      this.draw();
      return;
    }

    if (d.kind === "fade-out") {
      d.clip.fadeOutSec = clamp(clipEnd(d.clip) - t, 0, clipDuration(d.clip) * 0.98);
      this.draw();
      return;
    }
  }

  _onMouseUp() {
    if (!this._drag) return;
    const kind = this._drag.kind;
    this._drag = null;
    this.canvas.style.cursor = "default";
    if (["body", "trim-in", "trim-out", "fade-in", "fade-out"].includes(kind)) {
      this._changed(kind);
    }
    if (kind === "select") {
      this.dispatchEvent(new CustomEvent("selectionchange", { detail: this.selection }));
    }
  }

  _onDoubleClick(e) {
    const { x, y } = this._localPos(e);
    const hit = this.hitTest(x, y);
    if (hit.clip) {
      // Double-click selects the clip's full extent as the time selection —
      // makes "delete this whole clip's worth of time" one gesture.
      this.selection = { startSec: hit.clip.startSec, endSec: clipEnd(hit.clip) };
      this.selectedClipId = hit.clip.id;
      this.draw();
      this.dispatchEvent(new CustomEvent("selectionchange", { detail: this.selection }));
    }
  }

  _onWheel(e) {
    if (!this.project) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const { x } = this._localPos(e, e.currentTarget);
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, this.xToTime(x));
      return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      this.scrollTo(this.scrollSec + e.deltaX / this.pxPerSec);
    } else if (e.shiftKey) {
      e.preventDefault();
      this.scrollTo(this.scrollSec + e.deltaY / this.pxPerSec);
    }
  }

  setPlayhead(sec, emit = false) {
    this.playheadSec = Math.max(0, sec);
    this._persistView();
    this.draw();
    if (emit) this.dispatchEvent(new CustomEvent("seek", { detail: { sec: this.playheadSec } }));
  }

  /* ------------------------------------------------------------------ */
  /* Drag & drop                                                         */
  /* ------------------------------------------------------------------ */

  _dropInfo(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const timeSec = Math.max(0, this._snap(this.xToTime(x)));
    const hit = this.hitTest(x, y);
    // Landing on a clip or an existing lane targets that track; anything past
    // the last lane means "make me a new track for this".
    const track = hit.row ? hit.row.track : null;
    return { x, y, timeSec, track, onClip: !!hit.clip };
  }

  _onDragOver(e) {
    const types = e.dataTransfer?.types || [];
    const isFiles = Array.prototype.includes.call(types, "Files");
    const isSfx = Array.prototype.includes.call(types, "application/x-statevo-sfx");
    if (!isFiles && !isSfx) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const info = this._dropInfo(e);
    this._dropHint = info;
    this.draw();
  }

  _onDragLeave(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    this._dropHint = null;
    this.draw();
  }

  _onDrop(e) {
    const types = e.dataTransfer?.types || [];
    const isSfx = Array.prototype.includes.call(types, "application/x-statevo-sfx");
    const files = Array.from(e.dataTransfer?.files || []);
    if (!isSfx && !files.length) return;
    e.preventDefault();

    const info = this._dropInfo(e);
    this._dropHint = null;
    this.draw();

    if (isSfx) {
      let payload = null;
      try {
        payload = JSON.parse(e.dataTransfer.getData("application/x-statevo-sfx"));
      } catch {
        return;
      }
      this.dispatchEvent(
        new CustomEvent("dropsfx", {
          detail: { sound: payload, timeSec: info.timeSec, track: info.track },
        }),
      );
      return;
    }

    this.dispatchEvent(
      new CustomEvent("dropfiles", {
        detail: { files, timeSec: info.timeSec, track: info.track },
      }),
    );
  }

  /**
   * Place an already-imported take on the timeline.
   * Mirrors the desktop rule: a drop on an existing lane joins that track, a
   * drop past the last lane makes a new one, and a multi-file drop only lets
   * the first file land on the targeted track so five sounds don't stack.
   */
  placeTake(take, { timeSec = 0, track = null, name = null, newTrackName = null } = {}) {
    let target = track;
    if (!target) {
      target = this.addTrack(newTrackName || take.name?.slice(0, 22) || "SFX", TrackKind.SFX);
    }
    const clip = makeClip({
      takeId: take.id,
      name: name || take.name,
      startSec: Math.max(0, timeSec),
      sourceInSec: 0,
      sourceOutSec: take.durationSec,
      fadeInSec: 0.005,
      fadeOutSec: Math.min(0.02, take.durationSec / 4),
    });
    target.clips.push(clip);
    sortClips(target);
    this.selectedClipId = clip.id;
    this.setActiveTrack(target.id);
    this._changed("place clip");
    this.renderHeads();
    this.resize();
    return { clip, track: target };
  }

  /* ------------------------------------------------------------------ */
  /* Drawing                                                             */
  /* ------------------------------------------------------------------ */

  _changed(reason) {
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  draw() {
    if (!this.project || !this.ctx) return;
    this._drawRuler();
    const ctx = this.ctx;
    const W = this.viewW;
    const { rows, addY } = this.layout();

    ctx.clearRect(0, 0, W, this.viewH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, this.viewH);

    // Lanes
    rows.forEach((row, i) => {
      const active = row.track.id === this.activeTrackId;
      ctx.fillStyle = active ? COLORS.laneActive : i % 2 ? COLORS.laneAlt : COLORS.lane;
      ctx.fillRect(0, row.y, W, row.h - 1);
      ctx.fillStyle = COLORS.grid;
      ctx.fillRect(0, row.y + row.h - 1, W, 1);
      if (row.track.muted) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(0, row.y, W, row.h - 1);
      }
    });

    this._drawGrid(ctx, addY);

    // Selection band
    if (this.selection) {
      const x0 = this.timeToX(this.selection.startSec);
      const x1 = this.timeToX(this.selection.endSec);
      ctx.fillStyle = COLORS.selection;
      ctx.fillRect(x0, 0, x1 - x0, addY);
      ctx.strokeStyle = COLORS.selectionEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0);
      ctx.lineTo(x0 + 0.5, addY);
      ctx.moveTo(x1 - 0.5, 0);
      ctx.lineTo(x1 - 0.5, addY);
      ctx.stroke();
    }

    // Clips
    for (const row of rows) for (const clip of row.track.clips) this._drawClip(ctx, row, clip);

    // "+ new track" drop row
    ctx.fillStyle = COLORS.laneAlt;
    ctx.fillRect(0, addY, W, ADD_LANE_H);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = COLORS.grid;
    ctx.strokeRect(0.5, addY + 0.5, W - 1, ADD_LANE_H - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.textDim;
    ctx.font = "12px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.fillText("drop here for a new track", 12, addY + ADD_LANE_H / 2 + 4);

    this._drawDropHint(ctx, rows, addY);
    this._drawMarkerLines(ctx, addY);

    // Playhead
    const px = this.timeToX(this.playheadSec);
    if (px >= -1 && px <= W + 1) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(px), 0, 1.5, addY);
    }
  }

  _drawGrid(ctx, height) {
    const step = niceStep(this.pxPerSec);
    const first = Math.floor(this.scrollSec / step) * step;
    ctx.lineWidth = 1;
    for (let t = first; ; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      if (x > this.viewW) break;
      if (x < 0) continue;
      ctx.strokeStyle = Math.abs(t % (step * 5)) < 1e-6 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  _drawClip(ctx, row, clip) {
    const x0 = this.timeToX(clip.startSec);
    const x1 = this.timeToX(clipEnd(clip));
    if (x1 < -20 || x0 > this.viewW + 20) return;

    const isVoice = row.track.kind === TrackKind.VOICE;
    const pad = 3;
    const y = row.y + pad;
    const h = row.h - pad * 2 - 1;
    const w = Math.max(2, x1 - x0);
    const selected = clip.id === this.selectedClipId;

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x0, y, w, h, 4);
    ctx.clip();

    ctx.fillStyle = isVoice ? COLORS.clipVoiceBody : COLORS.clipSfxBody;
    ctx.fillRect(x0, y, w, h);

    // Header strip with the clip name
    const headH = row.track.collapsed ? h : 15;
    ctx.fillStyle = isVoice ? COLORS.clipVoice : COLORS.clipSfx;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x0, y, w, headH);
    ctx.globalAlpha = 1;

    if (w > 40) {
      ctx.fillStyle = "#0d1116";
      ctx.font = "600 10px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.fillText(truncate(ctx, clip.name || "clip", w - 10), x0 + 5, y + 11);
    }

    if (!row.track.collapsed && h > 30) {
      this._drawWaveform(ctx, clip, x0, y + headH, w, h - headH, isVoice);
    }

    // Fade ramps
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    if (clip.fadeInSec > 0) {
      const fx = this.timeToX(clip.startSec + clip.fadeInSec);
      ctx.beginPath();
      ctx.moveTo(x0, y + h);
      ctx.lineTo(fx, y + headH);
      ctx.stroke();
    }
    if (clip.fadeOutSec > 0) {
      const fx = this.timeToX(clipEnd(clip) - clip.fadeOutSec);
      ctx.beginPath();
      ctx.moveTo(fx, y + headH);
      ctx.lineTo(x1, y + h);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = selected ? COLORS.clipSelected : "rgba(0,0,0,0.6)";
    ctx.lineWidth = selected ? 1.6 : 1;
    roundRect(ctx, x0 + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
  }

  _drawWaveform(ctx, clip, x, y, w, h, isVoice) {
    const cached = this.getCache(clip.takeId);
    const mid = y + h / 2;
    if (!cached?.peaks) {
      ctx.fillStyle = COLORS.textDim;
      ctx.fillRect(x + 4, mid, Math.max(0, w - 8), 1);
      return;
    }
    const sr = cached.buffer.sampleRate;
    const startSample = Math.floor(clip.sourceInSec * sr);
    const endSample = Math.floor(clip.sourceOutSec * sr);
    const cols = Math.max(1, Math.floor(w));
    const { min, max } = readPeaks(cached.peaks, startSample, endSample, cols);

    ctx.fillStyle = isVoice ? COLORS.wave : COLORS.waveSfx;
    const half = h / 2 - 1;
    for (let i = 0; i < cols; i++) {
      const top = mid - max[i] * half;
      const bot = mid - min[i] * half;
      ctx.fillRect(x + i, top, 1, Math.max(1, bot - top));
    }
  }

  _drawMarkerLines(ctx, height) {
    for (const m of this.project.markers) {
      const x = Math.round(this.timeToX(m.timeSec)) + 0.5;
      if (x < 0 || x > this.viewW) continue;
      ctx.strokeStyle = "rgba(232,163,61,0.45)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawDropHint(ctx, rows, addY) {
    if (!this._dropHint) return;
    const { timeSec, track } = this._dropHint;
    const row = rows.find((r) => r.track === track);
    if (row) {
      ctx.fillStyle = COLORS.dropTarget;
      ctx.fillRect(0, row.y, this.viewW, row.h - 1);
    } else {
      ctx.fillStyle = COLORS.dropTargetNew;
      ctx.fillRect(0, addY, this.viewW, ADD_LANE_H);
    }
    const x = this.timeToX(timeSec);
    ctx.fillStyle = COLORS.selectionEdge;
    ctx.fillRect(Math.round(x), row ? row.y : addY, 2, row ? row.h - 1 : ADD_LANE_H);
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = COLORS.text;
    ctx.fillText(
      `${formatTime(timeSec)}${row ? ` → ${row.track.name}` : " → new track"}`,
      Math.round(x) + 6,
      (row ? row.y : addY) + 14,
    );
  }

  _drawRuler() {
    const ctx = this.rulerCtx;
    const W = this.viewW;
    ctx.clearRect(0, 0, W, RULER_H);
    ctx.fillStyle = "#0f1218";
    ctx.fillRect(0, 0, W, RULER_H);

    const step = niceStep(this.pxPerSec);
    const first = Math.floor(this.scrollSec / step) * step;
    ctx.font = "10px 'IBM Plex Mono', monospace";

    for (let t = first; ; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      if (x > W) break;
      if (x < -40) continue;
      const major = Math.abs(t % (step * 5)) < 1e-6;
      ctx.strokeStyle = major ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, major ? 12 : 20);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (major && x >= 0) {
        ctx.fillStyle = COLORS.textDim;
        ctx.fillText(formatTime(t, step < 1), x + 3, 11);
      }
    }

    // Markers as flags on the ruler
    for (const m of this.project.markers) {
      const x = Math.round(this.timeToX(m.timeSec)) + 0.5;
      if (x < -60 || x > W) continue;
      ctx.fillStyle = COLORS.marker;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 10);
      ctx.lineTo(x + 7, RULER_H - 6);
      ctx.lineTo(x, RULER_H - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 0.5, 0, 1, RULER_H);
      if (this.pxPerSec > 20) {
        ctx.fillStyle = "rgba(232,163,61,0.85)";
        ctx.font = "9px 'IBM Plex Sans', system-ui, sans-serif";
        ctx.fillText(truncate(ctx, m.label, 90), x + 9, RULER_H - 3);
      }
    }

    const px = this.timeToX(this.playheadSec);
    if (px >= -1 && px <= W + 1) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(px), 0, 1.5, RULER_H);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

function niceStep(pxPerSec) {
  const targetPx = 80;
  const raw = targetPx / pxPerSec;
  const steps = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= raw) return s;
  return 900;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncate(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

export { uid };
