/**
 * model.js — the project data model.
 *
 * Mirrors the desktop StateVO model deliberately: a Project owns Tracks,
 * Tracks own Clips, and Clips are *non-destructive references* into Takes.
 * A Take is one immutable slab of audio (a recording pass, a dropped file,
 * an SFX pull) and is never mutated after creation. Every edit — split,
 * trim, fade, move — only ever rewrites Clip fields.
 *
 * The whole model is plain JSON-serialisable data. Audio lives separately
 * in IndexedDB, keyed by take id (see storage.js).
 */

import { uid } from "./util.js";

export const PROJECT_FORMAT_VERSION = 2;

export const TrackKind = Object.freeze({
  VOICE: "voice",
  SFX: "sfx",
});

/** Default 5-stage voice chain. Mirrors core/presets.py on the desktop app. */
export function defaultVoiceChain() {
  return {
    preset: "social",
    cleanup: { on: true, thresholdDb: -45, ratio: 4, attackMs: 5, releaseMs: 90, highpassHz: 80 },
    deesser: { on: true, freqHz: 6500, thresholdDb: -26, ratio: 4 },
    compressor: { on: true, thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 140, makeupDb: 3 },
    eq: {
      on: true,
      highpassHz: 90,
      lowShelf: { freqHz: 200, gainDb: -1.5 },
      presence: { freqHz: 3200, gainDb: 2.5, q: 0.9 },
      air: { freqHz: 11000, gainDb: 1.5 },
    },
    limiter: { on: true, ceilingDb: -1.0, releaseMs: 60 },
  };
}

export function makeTake({
  id = uid("take"),
  name = "Take",
  sampleRate = 48000,
  channels = 1,
  durationSec = 0,
  source = "record",
  meta = {},
} = {}) {
  return { id, name, sampleRate, channels, durationSec, source, meta, createdAt: Date.now() };
}

export function makeClip({
  id = uid("clip"),
  takeId,
  name = "",
  startSec = 0,
  sourceInSec = 0,
  sourceOutSec = 0,
  gainDb = 0,
  fadeInSec = 0.005,
  fadeOutSec = 0.005,
} = {}) {
  return { id, takeId, name, startSec, sourceInSec, sourceOutSec, gainDb, fadeInSec, fadeOutSec };
}

export function makeTrack({
  id = uid("trk"),
  name = "Voice",
  kind = TrackKind.VOICE,
  clips = [],
  volumeDb = 0,
  muted = false,
  solo = false,
  collapsed = false,
  // Only meaningful on a voice-kind track — see audio/character.js.
  character = { type: "none", amount: 0.6 },
} = {}) {
  return { id, name, kind, clips, volumeDb, muted, solo, collapsed, character };
}

export function makeMarker({ id = uid("mk"), timeSec = 0, label = "Marker" } = {}) {
  return { id, timeSec, label };
}

export function makeProject({ name = "Untitled", sampleRate = 48000 } = {}) {
  const voice = makeTrack({ name: "Voice", kind: TrackKind.VOICE });
  const sfx = makeTrack({ name: "Beds / SFX", kind: TrackKind.SFX, collapsed: false });
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: uid("proj"),
    name,
    sampleRate,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: [voice, sfx],
    takes: {},
    markers: [],
    script: { text: "", sections: [] },
    voiceChain: defaultVoiceChain(),
    exportPresetId: "reels",
    // UI state that's worth persisting with the project
    view: { pxPerSec: 90, scrollSec: 0, playheadSec: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* Derived queries                                                     */
/* ------------------------------------------------------------------ */

export function clipDuration(clip) {
  return Math.max(0, clip.sourceOutSec - clip.sourceInSec);
}

export function clipEnd(clip) {
  return clip.startSec + clipDuration(clip);
}

export function trackEnd(track) {
  return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function projectDuration(project) {
  return project.tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
}

/** Tracks that will actually be heard, honouring solo. */
export function audibleTracks(project) {
  const soloed = project.tracks.filter((t) => t.solo);
  const pool = soloed.length ? soloed : project.tracks;
  return pool.filter((t) => !t.muted);
}

export function findTrack(project, trackId) {
  return project.tracks.find((t) => t.id === trackId) || null;
}

export function findClip(project, clipId) {
  for (const t of project.tracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

/** Keep clips ordered by start time — the timeline and renderer both assume it. */
export function sortClips(track) {
  track.clips.sort((a, b) => a.startSec - b.startSec);
  return track;
}

/** Drop takes no clip references any more, so storage can garbage-collect. */
export function orphanTakeIds(project) {
  const used = new Set();
  for (const t of project.tracks) for (const c of t.clips) used.add(c.takeId);
  return Object.keys(project.takes).filter((id) => !used.has(id));
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/**
 * Bring an older/partial project dict up to the current shape. Being
 * permissive here is what lets a project JSON exported months ago still
 * open — the format is meant to be human-readable and hand-editable.
 */
export function migrateProject(raw) {
  const base = makeProject({ name: raw?.name || "Untitled" });
  const p = { ...base, ...raw };
  p.formatVersion = PROJECT_FORMAT_VERSION;
  p.tracks = (raw?.tracks?.length ? raw.tracks : base.tracks).map((t) => ({
    ...makeTrack(),
    ...t,
    clips: (t.clips || []).map((c) => ({ ...makeClip({ takeId: c.takeId }), ...c })),
  }));
  p.takes = raw?.takes || {};
  p.markers = (raw?.markers || []).map((m) => ({ ...makeMarker(), ...m }));
  p.script = { text: "", sections: [], ...(raw?.script || {}) };
  // Merge voice chain stage-by-stage so a project saved before a new stage
  // existed still gets that stage's defaults rather than `undefined`.
  const vc = defaultVoiceChain();
  const rawVc = raw?.voiceChain || {};
  p.voiceChain = {
    preset: rawVc.preset || vc.preset,
    cleanup: { ...vc.cleanup, ...(rawVc.cleanup || {}) },
    deesser: { ...vc.deesser, ...(rawVc.deesser || {}) },
    compressor: { ...vc.compressor, ...(rawVc.compressor || {}) },
    eq: {
      ...vc.eq,
      ...(rawVc.eq || {}),
      lowShelf: { ...vc.eq.lowShelf, ...((rawVc.eq || {}).lowShelf || {}) },
      presence: { ...vc.eq.presence, ...((rawVc.eq || {}).presence || {}) },
      air: { ...vc.eq.air, ...((rawVc.eq || {}).air || {}) },
    },
    limiter: { ...vc.limiter, ...(rawVc.limiter || {}) },
  };
  p.view = { ...base.view, ...(raw?.view || {}) };
  return p;
}
