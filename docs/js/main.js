/**
 * main.js — application wiring.
 *
 * Everything that "knows the whole app" lives here: the current project, the
 * undo stack, the transport, and the wires between the timeline, the SFX
 * panel and the script panel. The panels themselves know nothing about each
 * other — they emit events, this file decides what they mean.
 */

import { engine } from "./audio/engine.js";
import { measureProject } from "./audio/render.js";
import { VOICE_PRESETS, applyPreset } from "./audio/voicechain.js";
import {
  makeProject, makeMarker, migrateProject, projectDuration,
  orphanTakeIds, TrackKind, clipEnd, findClip,
} from "./model.js";
import {
  splitAt, deleteRange, rippleDeleteAll, duplicateClip, nudgeClip, compRange,
} from "./editops.js";
import {
  saveProject, loadProject, listProjects, deleteProject, deleteAudio,
  getPref, setPref, storageEstimate, requestPersistence,
} from "./storage.js";
import { Timeline } from "./ui/timeline.js";
import { SfxPanel } from "./ui/sfx.js";
import { ScriptPanel, markersFromSections } from "./ui/script.js";
import { openExportDialog } from "./ui/exportdlg.js";
import { toast, toastOk, toastError, confirmDialog, promptDialog, progressOverlay } from "./ui/toast.js";
import {
  clamp, debounce, deepClone, downloadBlob, formatDb, formatTime,
  formatBytes, gainToDb, safeFilename, uid, readAsText,
} from "./util.js";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const app = {
  project: null,
  timeline: null,
  sfx: null,
  script: null,
  undo: [],
  redo: [],
  recordStartSec: 0,
  punch: null, // {startSec, endSec} when recording into a selection
  dirty: false,
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

init().catch((err) => {
  console.error(err);
  toastError(`Failed to start: ${err.message}`);
});

async function init() {
  app.timeline = new Timeline($("#timeline"), {
    getCache: (takeId) => engine.cache.get(takeId),
  });
  app.sfx = new SfxPanel($("#sfx-panel"));
  app.script = new ScriptPanel($("#script-panel"));

  wireTimeline();
  wireSfx();
  wireScript();
  wireTopbar();
  wireTransport();
  wireChainStrip();
  wireKeyboard();
  wireGutters();

  const lastId = await getPref("lastProjectId", null);
  let project = lastId ? await loadProject(lastId) : null;
  if (project) {
    project = migrateProject(project);
    setProject(project, { fresh: false });
    const missing = await engine.preloadProject(project).catch(() => []);
    if (missing?.length) {
      toast(`${missing.length} take${missing.length === 1 ? "" : "s"} couldn't be loaded from storage.`, "error", 6000);
    }
    app.timeline.draw();
    setStatus(`Reopened “${project.name}”.`);
  } else {
    setProject(makeProject({ name: "Untitled" }), { fresh: true });
    setStatus("New project. Hit Arm, then Record.");
  }

  refreshDevices();
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
  updateStorageLabel();
  requestAnimationFrame(tick);

  window.addEventListener("beforeunload", (e) => {
    if (!app.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

function setProject(project, { fresh } = {}) {
  app.project = project;
  app.undo = [];
  app.redo = [];
  $("#project-name").value = project.name;
  app.timeline.setProject(project);
  app.script.setProject(project);
  $("#chain-preset").value = project.voiceChain.preset || "social";
  renderChainStages();
  updateTotals();
  if (fresh) markDirty(false);
  setPref("lastProjectId", project.id);
}

/* ------------------------------------------------------------------ */
/* Undo / autosave                                                     */
/* ------------------------------------------------------------------ */

function pushUndo(label = "edit") {
  app.undo.push({ label, snapshot: deepClone(stripView(app.project)) });
  if (app.undo.length > 60) app.undo.shift();
  app.redo.length = 0;
}

function stripView(p) {
  const { view, ...rest } = p;
  return rest;
}

function undo() {
  if (!app.undo.length) {
    setStatus("Nothing to undo.");
    return;
  }
  const entry = app.undo.pop();
  app.redo.push({ label: entry.label, snapshot: deepClone(stripView(app.project)) });
  Object.assign(app.project, entry.snapshot);
  afterModelChange(`undo ${entry.label}`);
}

function redo() {
  if (!app.redo.length) return;
  const entry = app.redo.pop();
  app.undo.push({ label: entry.label, snapshot: deepClone(stripView(app.project)) });
  Object.assign(app.project, entry.snapshot);
  afterModelChange(`redo ${entry.label}`);
}

function afterModelChange(reason = "") {
  app.timeline.renderHeads();
  app.timeline.resize();
  app.script.renderMarkers();
  updateTotals();
  markDirty(true);
  if (reason) setStatus(reason);
}

function markDirty(v = true) {
  app.dirty = v;
  document.title = `${v ? "• " : ""}${app.project?.name || "StateVO"} — StateVO`;
  if (v) autosave();
}

const autosave = debounce(async () => {
  if (!app.project) return;
  try {
    await saveProject(app.project);
    app.dirty = false;
    document.title = `${app.project.name} — StateVO`;
    updateStorageLabel();
  } catch (err) {
    console.error(err);
    toastError("Autosave failed — your browser may be out of storage.");
  }
}, 1200);

/* ------------------------------------------------------------------ */
/* Timeline wiring                                                     */
/* ------------------------------------------------------------------ */

function wireTimeline() {
  const tl = app.timeline;

  tl.addEventListener("change", (e) => {
    // The timeline mutates the model in place during a drag; snapshot the
    // *result* rather than trying to snapshot mid-gesture.
    markDirty(true);
    updateTotals();
    if (e.detail?.reason !== "track collapse") app.timeline.draw();
  });

  tl.addEventListener("seek", (e) => {
    if (engine.playing) {
      engine.stop();
      startPlayback(e.detail.sec);
    }
  });

  tl.addEventListener("clipselect", (e) => {
    const { clip } = e.detail;
    setStatus(`${clip.name || "clip"} · ${formatTime(clip.startSec)} → ${formatTime(clipEnd(clip))}`);
  });

  tl.addEventListener("dropfiles", async (e) => {
    const { files, timeSec, track } = e.detail;
    await importFiles(files, { timeSec, track });
  });

  tl.addEventListener("dropsfx", async (e) => {
    const { sound, timeSec, track } = e.detail;
    await importSfx(sound, { timeSec, track });
  });
}

/* ------------------------------------------------------------------ */
/* SFX panel wiring                                                    */
/* ------------------------------------------------------------------ */

function wireSfx() {
  app.sfx.addEventListener("addsound", async (e) => {
    const track = app.timeline.activeTrack;
    await importSfx(e.detail.sound, {
      timeSec: app.timeline.playheadSec,
      track: track?.kind === TrackKind.SFX ? track : null,
    });
  });

  app.sfx.addEventListener("localfiles", async (e) => {
    await importFiles(e.detail.files, {
      timeSec: app.timeline.playheadSec,
      track: null,
    });
  });
}

/** Pull an SFX preview through the proxy, import it, drop it on the timeline. */
async function importSfx(sound, { timeSec, track }) {
  if (!app.sfx.configured) {
    toastError("Set the Freesound proxy URL in the SFX panel's ⚙ settings first.");
    return;
  }
  const prog = progressOverlay(`Fetching “${sound.name}”`);
  try {
    await engine.ensureContext();
    prog.update(0.3, "Downloading preview");
    const bytes = await app.sfx.fetchSoundBytes(sound);
    prog.update(0.65, "Decoding");
    const { take } = await engine.importAudio(bytes, {
      name: shortName(sound.name),
      source: "freesound",
      meta: {
        freesoundId: sound.id,
        license: sound.license,
        username: sound.username,
        url: `https://freesound.org/s/${sound.id}/`,
      },
    });
    pushUndo("add sfx");
    app.project.takes[take.id] = take;
    app.timeline.placeTake(take, { timeSec, track, newTrackName: shortName(sound.name, 16) });
    prog.close();
    toastOk(`Added “${take.name}”`);
    markDirty(true);
    updateTotals();
  } catch (err) {
    prog.close();
    console.error(err);
    toastError(err.message || "Couldn't add that sound.");
  }
}

/** Import one or more local audio files. */
async function importFiles(files, { timeSec, track }) {
  const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|mp3|ogg|flac|m4a|aac|opus|aiff?)$/i.test(f.name));
  if (!audio.length) {
    toastError("No audio files in that drop.");
    return;
  }
  const prog = progressOverlay(`Importing ${audio.length} file${audio.length === 1 ? "" : "s"}`);
  try {
    await engine.ensureContext();
    pushUndo("import files");
    let targetTrack = track;
    let cursor = timeSec;

    for (let i = 0; i < audio.length; i++) {
      const file = audio[i];
      prog.update((i + 0.5) / audio.length, file.name);
      const { take } = await engine.importAudio(file, {
        name: shortName(file.name.replace(/\.[^.]+$/, "")),
        source: "file",
        meta: { originalName: file.name },
      });
      app.project.takes[take.id] = take;

      // Only the first file honours the targeted track — otherwise a five-file
      // drop stacks five sounds on top of each other.
      const { clip } = app.timeline.placeTake(take, {
        timeSec: cursor,
        track: i === 0 ? targetTrack : null,
        newTrackName: shortName(file.name.replace(/\.[^.]+$/, ""), 16),
      });
      if (i === 0 && targetTrack) cursor = clipEnd(clip) + 0.05;
    }
    prog.close();
    toastOk(`Imported ${audio.length} file${audio.length === 1 ? "" : "s"}`);
    markDirty(true);
    updateTotals();
  } catch (err) {
    prog.close();
    console.error(err);
    toastError(err.message || "Import failed.");
  }
}

function shortName(s, max = 28) {
  s = String(s || "sound").replace(/[_-]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* Script panel wiring                                                 */
/* ------------------------------------------------------------------ */

function wireScript() {
  app.script.addEventListener("change", () => markDirty(true));

  app.script.addEventListener("seek", (e) => {
    app.timeline.setPlayhead(e.detail.sec);
    if (engine.playing) {
      engine.stop();
      startPlayback(e.detail.sec);
    }
  });

  app.script.addEventListener("addmarker", () => addMarkerAtPlayhead());

  app.script.addEventListener("placesection", (e) => {
    pushUndo("place section marker");
    app.project.markers.push(
      makeMarker({ timeSec: app.timeline.playheadSec, label: e.detail.section.title }),
    );
    app.script.renderMarkers();
    app.timeline.draw();
    markDirty(true);
    setStatus(`Marker “${e.detail.section.title}” at ${formatTime(app.timeline.playheadSec)}`);
  });

  app.script.addEventListener("markersfromsections", () => {
    const sections = app.project.script.sections || [];
    if (!sections.length) return;
    pushUndo("markers from sections");
    const dur = projectDuration(app.project);
    app.project.markers = markersFromSections(sections, dur);
    app.script.renderMarkers();
    app.timeline.draw();
    markDirty(true);
    toastOk(`${sections.length} markers placed — drag the playhead and use ◎ to fine-tune.`);
  });
}

function addMarkerAtPlayhead() {
  pushUndo("add marker");
  const n = app.project.markers.length + 1;
  app.project.markers.push(makeMarker({ timeSec: app.timeline.playheadSec, label: `Marker ${n}` }));
  app.script.renderMarkers();
  app.timeline.draw();
  markDirty(true);
  setStatus(`Marker at ${formatTime(app.timeline.playheadSec)}`);
}

/* ------------------------------------------------------------------ */
/* Topbar / project management                                         */
/* ------------------------------------------------------------------ */

function wireTopbar() {
  $("#project-name").addEventListener("change", (e) => {
    app.project.name = e.target.value.trim() || "Untitled";
    e.target.value = app.project.name;
    markDirty(true);
  });
  $("#project-name").addEventListener("keydown", (e) => e.stopPropagation());

  $("#btn-new").addEventListener("click", async () => {
    if (app.dirty) await saveProject(app.project);
    const name = await promptDialog("New project", { value: "Untitled", okLabel: "Create" });
    if (name === null) return;
    engine.stop();
    setProject(makeProject({ name: name.trim() || "Untitled" }), { fresh: true });
    toastOk("New project");
  });

  $("#btn-save").addEventListener("click", async () => {
    await saveProject(app.project);
    app.dirty = false;
    document.title = `${app.project.name} — StateVO`;
    updateStorageLabel();
    toastOk("Saved");
  });

  $("#btn-open").addEventListener("click", openProjectPicker);

  $("#btn-export-proj").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(app.project, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${safeFilename(app.project.name)}.statevo.json`);
    toast("Project file saved. Audio stays in this browser — export audio separately.", "info", 5000);
  });

  $("#btn-import-proj").addEventListener("click", () => $("#file-project").click());
  $("#file-project").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await readAsText(file));
      const project = migrateProject(raw);
      project.id = raw.id || uid("proj");
      setProject(project, { fresh: false });
      const missing = await engine.preloadProject(project).catch(() => []);
      app.timeline.draw();
      if (missing?.length) {
        toast(
          `Opened, but ${missing.length} take${missing.length === 1 ? "'s" : "s'"} audio isn't in this browser's storage.`,
          "error", 7000,
        );
      } else {
        toastOk("Project imported");
      }
      markDirty(true);
    } catch (err) {
      toastError(`Not a valid StateVO project: ${err.message}`);
    }
    e.target.value = "";
  });

  $("#btn-export").addEventListener("click", () =>
    openExportDialog(app.project, engine.cache, { defaultPreset: app.project.exportPresetId }),
  );

  $("#btn-help").addEventListener("click", showHelp);
}

async function openProjectPicker() {
  const projects = await listProjects();
  const el = document.createElement("div");
  el.className = "overlay";
  el.innerHTML = `
    <div class="overlay-card overlay-wide">
      <h3>Open project</h3>
      ${
        projects.length
          ? `<div class="proj-list">${projects
              .map(
                (p) => `
            <div class="proj-row" data-id="${p.id}">
              <button class="proj-open">
                <b>${p.name.replace(/</g, "&lt;")}</b>
                <span>${new Date(p.updatedAt).toLocaleString()}</span>
              </button>
              <button class="proj-del" title="Delete">✕</button>
            </div>`,
              )
              .join("")}</div>`
          : `<p class="overlay-body">No saved projects yet.</p>`
      }
      <div class="overlay-actions"><button class="btn-ghost" data-act="cancel">Close</button></div>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener("click", async (e) => {
    if (e.target.dataset?.act === "cancel") return el.remove();

    const row = e.target.closest(".proj-row");
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest(".proj-del")) {
      const ok = await confirmDialog(
        "Delete project?",
        "This removes the project and its recorded audio from this browser. It can't be undone.",
        { okLabel: "Delete", danger: true },
      );
      if (!ok) return;
      const p = await loadProject(id);
      await deleteProject(id, p ? Object.keys(p.takes || {}) : []);
      row.remove();
      updateStorageLabel();
      toastOk("Deleted");
      return;
    }

    if (e.target.closest(".proj-open")) {
      el.remove();
      if (app.dirty) await saveProject(app.project);
      engine.stop();
      const raw = await loadProject(id);
      if (!raw) return toastError("Couldn't load that project.");
      const project = migrateProject(raw);
      setProject(project, { fresh: false });
      const missing = await engine.preloadProject(project).catch(() => []);
      app.timeline.draw();
      if (missing?.length) toast(`${missing.length} take(s) missing audio.`, "error", 6000);
      toastOk(`Opened “${project.name}”`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function wireTransport() {
  $("#btn-arm").addEventListener("click", toggleArm);
  $("#btn-record").addEventListener("click", toggleRecord);
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-stop").addEventListener("click", () => engine.stop());
  $("#btn-home").addEventListener("click", () => {
    engine.stop();
    app.timeline.setPlayhead(0);
    app.timeline.scrollTo(0);
  });

  $("#input-device").addEventListener("change", async () => {
    if (engine.armed) await armInput();
  });

  const gain = $("#input-gain");
  gain.addEventListener("input", () => {
    const db = parseFloat(gain.value);
    engine.setInputGainDb(db);
    $("#input-gain-val").textContent = `${db.toFixed(1)} dB`;
  });

  $("#chk-monitor").addEventListener("change", (e) => {
    engine.setMonitoring(e.target.checked);
    if (e.target.checked) toast("Monitoring on — use headphones.", "info", 4000);
  });

  $("#btn-take-prev").addEventListener("click", () => cycleTake(-1));
  $("#btn-take-next").addEventListener("click", () => cycleTake(1));

  engine.addEventListener("playstop", () => {
    $("#btn-play").textContent = "▶";
    $("#btn-play").classList.remove("is-on");
  });
  engine.addEventListener("playstart", () => {
    $("#btn-play").textContent = "❚❚";
    $("#btn-play").classList.add("is-on");
  });
}

async function toggleArm() {
  if (engine.armed) {
    engine.disarm();
    $("#btn-arm").textContent = "Arm";
    $("#btn-arm").classList.remove("is-on");
    setStatus("Input closed.");
    return;
  }
  await armInput();
}

async function armInput() {
  try {
    await engine.ensureContext();
    const deviceId = $("#input-device").value || null;
    const label = await engine.arm(deviceId);
    $("#btn-arm").textContent = "Armed";
    $("#btn-arm").classList.add("is-on");
    $("#status-sr").textContent = `${engine.sampleRate} Hz`;
    app.project.sampleRate = engine.sampleRate;
    await refreshDevices();
    setStatus(`Input: ${label || "default"} · ${engine.sampleRate} Hz`);
    await requestPersistence();
  } catch (err) {
    console.error(err);
    toastError(
      err.name === "NotAllowedError"
        ? "Microphone permission denied — allow it in the address bar, then hit Arm again."
        : `Couldn't open the microphone: ${err.message}`,
    );
  }
}

async function refreshDevices() {
  const sel = $("#input-device");
  const current = sel.value;
  const devices = await engine.listInputDevices().catch(() => []);
  sel.innerHTML =
    `<option value="">System default</option>` +
    devices
      .map((d) => `<option value="${d.id}">${d.label.replace(/</g, "&lt;")}</option>`)
      .join("");
  if (current) sel.value = current;
}

async function toggleRecord() {
  if (engine.recording) {
    await stopRecording();
    return;
  }
  if (!engine.armed) {
    await armInput();
    if (!engine.armed) return;
  }

  engine.stop();

  // A time selection means punch-in: record only over that range.
  const sel = app.timeline.selection;
  app.punch = sel && sel.endSec - sel.startSec > 0.2 ? { ...sel } : null;
  app.recordStartSec = app.punch ? app.punch.startSec : app.timeline.playheadSec;

  engine.startRecording();
  $("#btn-record").classList.add("is-recording");
  $("#btn-record .rec-label").textContent = "Stop";
  setStatus(
    app.punch
      ? `Punching in ${formatTime(app.punch.startSec)} → ${formatTime(app.punch.endSec)}`
      : `Recording from ${formatTime(app.recordStartSec)}`,
  );

  if (app.punch) {
    app._punchTimer = setTimeout(
      () => stopRecording(),
      (app.punch.endSec - app.punch.startSec) * 1000,
    );
  }
}

async function stopRecording() {
  clearTimeout(app._punchTimer);
  const track = voiceTargetTrack();
  const takeNo = Object.values(app.project.takes).filter((t) => t.source === "record").length + 1;
  const result = await engine.stopRecording(`Take ${takeNo}`);

  $("#btn-record").classList.remove("is-recording");
  $("#btn-record .rec-label").textContent = "Record";

  if (!result) {
    setStatus("Nothing captured.");
    return;
  }

  pushUndo("record");
  const { take } = result;
  app.project.takes[take.id] = take;

  const start = app.recordStartSec;
  const end = start + take.durationSec;

  // Multi-take: everything recorded over the same region joins one stack, so
  // the ◀ ▶ take buttons can swap between them without losing any audio.
  app.project.takeStacks = app.project.takeStacks || [];
  let stack = app.project.takeStacks.find(
    (s) => s.trackId === track.id && Math.abs(s.startSec - start) < 0.25,
  );
  if (!stack) {
    stack = { id: uid("stk"), trackId: track.id, startSec: start, endSec: end, takeIds: [], active: 0 };
    app.project.takeStacks.push(stack);
  }
  stack.takeIds.push(take.id);
  stack.active = stack.takeIds.length - 1;
  stack.endSec = Math.max(stack.endSec, end);

  // Replace whatever was under this region on the target track.
  deleteRange(track, start, end, { ripple: false });
  compRange(track, start, end, take, { sourceOffsetSec: 0 });

  app.timeline.setActiveTrack(track.id);
  app.timeline.setPlayhead(end);
  app.timeline.selection = null;
  app.punch = null;
  afterModelChange(`${take.name} · ${formatTime(take.durationSec)}`);
  updateTakeLabel();
  app.timeline.followPlayhead();
}

/** Where a new recording lands: the active track if it's a voice track. */
function voiceTargetTrack() {
  const active = app.timeline.activeTrack;
  if (active?.kind === TrackKind.VOICE) return active;
  const firstVoice = app.project.tracks.find((t) => t.kind === TrackKind.VOICE);
  return firstVoice || app.timeline.addTrack("Voice", TrackKind.VOICE);
}

function currentStack() {
  const stacks = app.project.takeStacks || [];
  const t = app.timeline.playheadSec;
  const trackId = app.timeline.activeTrack?.id;
  return (
    stacks.find((s) => s.trackId === trackId && t >= s.startSec - 0.05 && t <= s.endSec + 0.05) ||
    stacks.filter((s) => s.trackId === trackId).slice(-1)[0] ||
    null
  );
}

function cycleTake(dir) {
  const stack = currentStack();
  if (!stack || stack.takeIds.length < 2) {
    setStatus("Only one take here — record again over the same spot to build a stack.");
    return;
  }
  pushUndo("switch take");
  stack.active = (stack.active + dir + stack.takeIds.length) % stack.takeIds.length;
  const take = app.project.takes[stack.takeIds[stack.active]];
  const track = app.project.tracks.find((t) => t.id === stack.trackId);
  if (!take || !track) return;

  deleteRange(track, stack.startSec, stack.endSec, { ripple: false });
  compRange(track, stack.startSec, Math.min(stack.endSec, stack.startSec + take.durationSec), take);
  afterModelChange(`${take.name} (${stack.active + 1}/${stack.takeIds.length})`);
  updateTakeLabel();
}

function updateTakeLabel() {
  const stack = currentStack();
  const el = $("#take-label");
  if (!stack) {
    const n = Object.values(app.project.takes).filter((t) => t.source === "record").length;
    el.textContent = n ? `${n} take${n === 1 ? "" : "s"}` : "no takes";
    return;
  }
  el.textContent = `take ${stack.active + 1}/${stack.takeIds.length}`;
}

function togglePlay() {
  if (engine.playing) {
    engine.stop();
    return;
  }
  startPlayback(app.timeline.playheadSec);
}

async function startPlayback(fromSec) {
  try {
    const n = await engine.play(app.project, fromSec, {
      throughChain: $("#chk-chain-preview").checked,
    });
    if (!n) setStatus("Nothing to play from here.");
  } catch (err) {
    console.error(err);
    toastError(`Playback failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Voice chain strip                                                   */
/* ------------------------------------------------------------------ */

function wireChainStrip() {
  $("#chain-preset").addEventListener("change", (e) => {
    pushUndo("voice preset");
    applyPreset(app.project.voiceChain, e.target.value);
    renderChainStages();
    engine.updateChain(app.project.voiceChain);
    markDirty(true);
    setStatus(`Voice chain: ${VOICE_PRESETS[e.target.value].label} — ${VOICE_PRESETS[e.target.value].hint}`);
  });

  document.querySelectorAll(".stage").forEach((btn) => {
    btn.addEventListener("click", () => {
      const stage = btn.dataset.stage;
      pushUndo(`toggle ${stage}`);
      const vc = app.project.voiceChain;
      vc[stage].on = !vc[stage].on;
      renderChainStages();
      engine.updateChain(vc);
      markDirty(true);
    });
  });

  $("#chk-chain-preview").addEventListener("change", () => {
    if (engine.playing) {
      const at = engine.positionSec;
      engine.stop();
      startPlayback(at);
    }
  });

  $("#btn-measure").addEventListener("click", measureLoudness);
}

function renderChainStages() {
  const vc = app.project.voiceChain;
  document.querySelectorAll(".stage").forEach((btn) => {
    btn.classList.toggle("is-off", !vc[btn.dataset.stage]?.on);
  });
  // Keep the sub-labels honest about what the preset actually set.
  const set = (sel, text) => {
    const el = document.querySelector(`.stage[data-stage="${sel}"] span`);
    if (el) el.textContent = text;
  };
  set("cleanup", `gate ${vc.cleanup.thresholdDb} dB`);
  set("deesser", `${(vc.deesser.freqHz / 1000).toFixed(1)} kHz`);
  set("compressor", `${vc.compressor.ratio}:1`);
  set("eq", `HP ${vc.eq.highpassHz} Hz`);
  set("limiter", `${vc.limiter.ceilingDb} dB`);
}

async function measureLoudness() {
  if (projectDuration(app.project) <= 0) {
    setStatus("Nothing to measure yet.");
    return;
  }
  const btn = $("#btn-measure");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const { integrated, truePeak } = await measureProject(app.project, engine.cache, {
      applyChain: $("#chk-chain-preview").checked,
    });
    $("#lufs-value").textContent = formatDb(integrated);
    $("#tp-value").textContent = formatDb(truePeak);
    const target = -14;
    const delta = isFinite(integrated) ? integrated - target : 0;
    $("#lufs-value").className = Math.abs(delta) <= 1 ? "is-good" : Math.abs(delta) <= 3 ? "is-warn" : "is-bad";
    setStatus(
      isFinite(integrated)
        ? `${formatDb(integrated)} LUFS integrated · ${formatDb(truePeak)} dBTP — export normalises to the preset target.`
        : "Silence.",
    );
  } catch (err) {
    console.error(err);
    toastError(`Measurement failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Measure";
  }
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      $("#btn-save").click();
      return;
    }
    if (mod && e.key.toLowerCase() === "e") {
      e.preventDefault();
      $("#btn-export").click();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (mod) return;

    const tl = app.timeline;
    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      case "Escape":
        engine.stop();
        break;
      case "Home":
        engine.stop();
        tl.setPlayhead(0);
        tl.scrollTo(0);
        break;
      case "r":
      case "R":
        e.preventDefault();
        toggleRecord();
        break;
      case "s":
      case "S": {
        const track = tl.activeTrack;
        if (!track) break;
        pushUndo("split");
        const n = splitAt(track, tl.playheadSec);
        afterModelChange(n ? `Split ${n} clip${n === 1 ? "" : "s"}` : "Nothing to split here.");
        break;
      }
      case "Delete":
      case "Backspace": {
        const sel = tl.selection;
        if (sel) {
          pushUndo("delete range");
          if (e.shiftKey) {
            rippleDeleteAll(app.project, sel.startSec, sel.endSec);
            afterModelChange("Ripple-deleted across all tracks.");
          } else {
            deleteRange(tl.activeTrack, sel.startSec, sel.endSec, { ripple: false });
            afterModelChange("Deleted selection.");
          }
          tl.selection = null;
        } else if (tl.selectedClipId) {
          const found = findClip(app.project, tl.selectedClipId);
          if (found) {
            pushUndo("delete clip");
            found.track.clips = found.track.clips.filter((c) => c.id !== tl.selectedClipId);
            tl.selectedClipId = null;
            afterModelChange("Deleted clip.");
          }
        }
        break;
      }
      case "m":
      case "M":
        addMarkerAtPlayhead();
        break;
      case "d":
      case "D": {
        if (!tl.selectedClipId) break;
        const found = findClip(app.project, tl.selectedClipId);
        if (!found) break;
        pushUndo("duplicate clip");
        const copy = duplicateClip(found.track, found.clip);
        tl.selectedClipId = copy.id;
        afterModelChange("Duplicated clip.");
        break;
      }
      case "[":
      case "]": {
        if (!tl.selectedClipId) break;
        const found = findClip(app.project, tl.selectedClipId);
        if (!found) break;
        nudgeClip(found.clip, e.key === "[" ? -0.01 : 0.01);
        tl.draw();
        markDirty(true);
        break;
      }
      case "+":
      case "=":
        tl.zoom(1.35);
        break;
      case "-":
      case "_":
        tl.zoom(1 / 1.35);
        break;
      case "f":
      case "F":
        tl.zoomToFit();
        break;
      default:
        return;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Panel resizing                                                      */
/* ------------------------------------------------------------------ */

function wireGutters() {
  document.querySelectorAll(".gutter").forEach((g) => {
    let dragging = false;
    g.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      document.body.classList.add("is-resizing");
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const side = g.dataset.target;
      const panel = side === "left" ? $("#sfx-panel") : $("#script-panel");
      const w =
        side === "left" ? e.clientX : window.innerWidth - e.clientX;
      panel.style.width = `${clamp(w, 210, 560)}px`;
      app.timeline.resize();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      document.body.classList.remove("is-resizing");
    });
    g.addEventListener("dblclick", () => {
      const side = g.dataset.target;
      const panel = side === "left" ? $("#sfx-panel") : $("#script-panel");
      panel.classList.toggle("is-collapsed");
      app.timeline.resize();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                          */
/* ------------------------------------------------------------------ */

let lastStorageCheck = 0;

function tick(ts) {
  requestAnimationFrame(tick);
  if (!app.project) return;

  // Transport clock + playhead
  if (engine.playing) {
    const pos = engine.positionSec;
    app.timeline.playheadSec = pos;
    app.timeline.followPlayhead();
    app.timeline.draw();
    $("#clock-main").textContent = formatTime(pos);
    app.script.syncToTime(pos);
  } else if (engine.recording) {
    const pos = app.recordStartSec + engine.elapsedRecordingSec;
    app.timeline.playheadSec = pos;
    app.timeline.followPlayhead();
    app.timeline.draw();
    $("#clock-main").textContent = formatTime(pos);
  }

  // Meters
  setMeter("#meter-in", engine.inputPeak);
  setMeter("#meter-out", engine.playing ? engine.outputPeak() : 0);

  if (ts - lastStorageCheck > 20000) {
    lastStorageCheck = ts;
    updateStorageLabel();
  }
}

function setMeter(sel, peak) {
  const el = document.querySelector(sel);
  if (!el) return;
  const db = peak > 0 ? gainToDb(peak) : -60;
  const pct = clamp((db + 54) / 54, 0, 1) * 100;
  el.querySelector(".meter-fill").style.width = `${pct}%`;
  el.classList.toggle("is-hot", db > -1.5);
  el.classList.toggle("is-warm", db > -8 && db <= -1.5);
}

function updateTotals() {
  const dur = projectDuration(app.project);
  $("#clock-total").textContent = `/ ${formatTime(dur)}`;
  if (!engine.playing && !engine.recording) $("#clock-main").textContent = formatTime(app.timeline.playheadSec);
  updateTakeLabel();
}

async function updateStorageLabel() {
  const est = await storageEstimate();
  if (!est) return;
  $("#status-storage").textContent = `${formatBytes(est.usage)} used`;
}

function setStatus(msg) {
  $("#status-msg").textContent = msg;
}

function showHelp() {
  const tpl = document.getElementById("tpl-help");
  const el = document.createElement("div");
  el.className = "overlay";
  el.innerHTML = `<div class="overlay-card overlay-wide"></div>`;
  el.querySelector(".overlay-card").appendChild(tpl.content.cloneNode(true));
  const actions = document.createElement("div");
  actions.className = "overlay-actions";
  actions.innerHTML = `<button class="btn" data-act="ok">Got it</button>`;
  el.querySelector(".overlay-card").appendChild(actions);
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    if (e.target.dataset?.act === "ok" || e.target === el) el.remove();
  });
}

// Expose a little of the app for console debugging — handy when something
// misbehaves in a real session and you want to poke at the model.
window.StateVO = { app, engine };
