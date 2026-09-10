/**
 * render.js — offline mixdown, loudness normalisation and encoding.
 *
 * The export pipeline, in order:
 *
 *   render_master (chain, limiter OFF)
 *        -> measure integrated LUFS
 *        -> apply the gain that hits the preset's target
 *        -> limiter pass at the preset ceiling   (this is why the limiter is
 *        -> re-measure for the report               off in the first pass)
 *        -> resample if the preset asks for it
 *        -> encode
 *
 * Normalising *before* the limiter rather than after is the whole reason the
 * two passes exist: normalise after limiting and you either overshoot the
 * ceiling or leave loudness on the table.
 */

import { ensureWorklets, createVoiceChain } from "./voicechain.js";
import { encodeWav } from "./wav.js";
import { integratedLoudness, truePeakDb, samplePeakDb } from "./loudness.js";
import { audibleTracks, clipDuration, clipEnd, projectDuration } from "../model.js";
import { dbToGain, isoDate, safeFilename } from "../util.js";

/* ------------------------------------------------------------------ */
/* Export presets                                                      */
/* ------------------------------------------------------------------ */

export const EXPORT_PRESETS = {
  reels: {
    id: "reels",
    label: "Instagram Reel / TikTok",
    hint: "−14 LUFS · MP3 320 · 48 kHz",
    format: "mp3",
    bitrate: 320,
    sampleRate: 48000,
    targetLufs: -14,
    ceilingDb: -1.0,
    suffix: "reels",
  },
  youtube: {
    id: "youtube",
    label: "YouTube / general",
    hint: "−14 LUFS · MP3 320 · 48 kHz",
    format: "mp3",
    bitrate: 320,
    sampleRate: 48000,
    targetLufs: -14,
    ceilingDb: -1.0,
    suffix: "yt",
  },
  podcast: {
    id: "podcast",
    label: "Podcast",
    hint: "−16 LUFS · MP3 192 · 44.1 kHz",
    format: "mp3",
    bitrate: 192,
    sampleRate: 44100,
    targetLufs: -16,
    ceilingDb: -1.5,
    suffix: "podcast",
  },
  wav: {
    id: "wav",
    label: "Clean WAV",
    hint: "No normalisation · 24-bit · project rate",
    format: "wav",
    bitDepth: 24,
    sampleRate: null, // keep project rate
    targetLufs: null, // no normalisation
    ceilingDb: null,
    suffix: "clean",
  },
  wav_normalised: {
    id: "wav_normalised",
    label: "WAV, normalised",
    hint: "−14 LUFS · 24-bit · project rate",
    format: "wav",
    bitDepth: 24,
    sampleRate: null,
    targetLufs: -14,
    ceilingDb: -1.0,
    suffix: "master",
  },
};

/* ------------------------------------------------------------------ */
/* Mixdown                                                             */
/* ------------------------------------------------------------------ */

/**
 * Render every audible clip into one buffer.
 *
 * @param {object} project
 * @param {Map} takeCache  engine.cache — takeId -> { buffer }
 * @param {{applyChain?: boolean, withLimiter?: boolean, sampleRate?: number,
 *          durationSec?: number}} opts
 * @returns {Promise<AudioBuffer>}
 */
export async function renderMix(project, takeCache, opts = {}) {
  const sampleRate = opts.sampleRate || project.sampleRate || 48000;
  const duration = opts.durationSec ?? projectDuration(project);
  // A tail so a limiter release or a fade-out isn't cut mid-decay.
  const totalSec = Math.max(0.1, duration + 0.25);
  const frames = Math.ceil(totalSec * sampleRate);

  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  await ensureWorklets(ctx);

  const master = ctx.createGain();
  master.connect(ctx.destination);

  let chain = null;
  if (opts.applyChain) {
    chain = createVoiceChain(ctx, project.voiceChain, { channels: 2 });
    if (opts.withLimiter === false) chain.setLimiterEnabled(false);
    chain.output.connect(master);
  }

  for (const track of audibleTracks(project)) {
    const trackGain = ctx.createGain();
    trackGain.gain.value = dbToGain(track.volumeDb);
    // Voice goes through the chain; beds/SFX are already produced material.
    trackGain.connect(chain && track.kind === "voice" ? chain.input : master);

    for (const clip of track.clips) {
      const dur = clipDuration(clip);
      if (dur <= 0) continue;
      const cached = takeCache.get(clip.takeId);
      if (!cached?.buffer) continue;

      const src = ctx.createBufferSource();
      src.buffer = cached.buffer;
      const g = ctx.createGain();

      const base = dbToGain(clip.gainDb);
      const at = clip.startSec;
      g.gain.setValueAtTime(clip.fadeInSec > 0 ? 0.0001 : base, at);
      if (clip.fadeInSec > 0) g.gain.exponentialRampToValueAtTime(base, at + clip.fadeInSec);
      if (clip.fadeOutSec > 0) {
        const foStart = Math.max(at + clip.fadeInSec, clipEnd(clip) - clip.fadeOutSec);
        g.gain.setValueAtTime(base, foStart);
        g.gain.exponentialRampToValueAtTime(0.0001, clipEnd(clip));
      }

      src.connect(g);
      g.connect(trackGain);
      src.start(at, clip.sourceInSec, dur);
    }
  }

  const rendered = await ctx.startRendering();
  chain?.dispose();
  return rendered;
}

/** Run just the limiter over a buffer — the second export pass. */
async function limiterPass(buffer, { ceilingDb, releaseMs = 60, sampleRate }) {
  const targetRate = sampleRate || buffer.sampleRate;
  const frames = Math.ceil((buffer.duration * targetRate) / 1) + 512;
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
  await ensureWorklets(ctx);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const limiter = new AudioWorkletNode(ctx, "limiter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [buffer.numberOfChannels],
    processorOptions: { on: true, ceilingDb, releaseMs },
  });
  src.connect(limiter);
  limiter.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/** Resample only (no processing) by rendering through a context at the new rate. */
async function resamplePass(buffer, targetRate) {
  if (buffer.sampleRate === targetRate) return buffer;
  const frames = Math.ceil(buffer.duration * targetRate);
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

function bufferChannels(buffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

function applyGain(buffer, gain) {
  if (gain === 1) return buffer;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/** MP3 via the vendored lamejs build (loaded by a plain <script> tag). */
export function encodeMp3(channels, sampleRate, kbps = 320, onProgress) {
  const lame = window.lamejs;
  if (!lame?.Mp3Encoder) {
    throw new Error("MP3 encoder failed to load — export as WAV, or reload the page.");
  }
  const numCh = Math.min(channels.length, 2);
  const encoder = new lame.Mp3Encoder(numCh, sampleRate, kbps);
  const blockSize = 1152;
  const frames = channels[0].length;
  const parts = [];

  const toInt16 = (f32, start, len) => {
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, f32[start + i] || 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };

  for (let i = 0; i < frames; i += blockSize) {
    const len = Math.min(blockSize, frames - i);
    const l = toInt16(channels[0], i, len);
    const buf =
      numCh === 2
        ? encoder.encodeBuffer(l, toInt16(channels[1], i, len))
        : encoder.encodeBuffer(l);
    if (buf.length) parts.push(new Uint8Array(buf));
    if (onProgress && (i / blockSize) % 200 === 0) onProgress(i / frames);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: "audio/mpeg" });
}

/* ------------------------------------------------------------------ */
/* The export entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} project
 * @param {Map} takeCache
 * @param {object} preset  one of EXPORT_PRESETS
 * @param {{applyChain?: boolean, onProgress?: (p:number, label:string)=>void}} opts
 * @returns {Promise<{blob: Blob, filename: string, report: object}>}
 */
export async function exportProject(project, takeCache, preset, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const applyChain = opts.applyChain !== false;
  const normalise = preset.targetLufs !== null && preset.targetLufs !== undefined;

  progress(0.05, "Mixing down");
  let buffer = await renderMix(project, takeCache, {
    applyChain,
    withLimiter: !normalise, // if we're normalising, limit in pass 2 instead
    sampleRate: project.sampleRate,
  });

  progress(0.35, "Measuring loudness");
  let channels = bufferChannels(buffer);
  const before = integratedLoudness(channels, buffer.sampleRate);

  let report = {
    preset: preset.id,
    targetLufs: preset.targetLufs,
    measuredBeforeLufs: round1(before.integrated),
    appliedGainDb: 0,
  };

  if (normalise) {
    const deltaDb = isFinite(before.integrated) ? preset.targetLufs - before.integrated : 0;
    report.appliedGainDb = round1(deltaDb);
    applyGain(buffer, dbToGain(deltaDb));

    progress(0.5, "Limiting");
    buffer = await limiterPass(buffer, {
      ceilingDb: preset.ceilingDb ?? -1.0,
      releaseMs: project.voiceChain?.limiter?.releaseMs ?? 60,
    });
  }

  if (preset.sampleRate && preset.sampleRate !== buffer.sampleRate) {
    progress(0.62, "Resampling");
    buffer = await resamplePass(buffer, preset.sampleRate);
  }

  progress(0.72, "Verifying");
  channels = bufferChannels(buffer);
  const after = integratedLoudness(channels, buffer.sampleRate);
  report = {
    ...report,
    measuredAfterLufs: round1(after.integrated),
    truePeakDbtp: round1(truePeakDb(channels)),
    samplePeakDbfs: round1(samplePeakDb(channels)),
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    durationSec: round1(buffer.duration),
    voiceChainApplied: applyChain,
    voiceChainPreset: project.voiceChain?.preset,
    generatedAt: new Date().toISOString(),
  };

  progress(0.8, preset.format === "mp3" ? "Encoding MP3" : "Writing WAV");
  let blob;
  if (preset.format === "mp3") {
    blob = encodeMp3(channels, buffer.sampleRate, preset.bitrate, (p) =>
      progress(0.8 + p * 0.18, "Encoding MP3"),
    );
  } else {
    blob = encodeWav(channels, buffer.sampleRate, preset.bitDepth || 24);
  }

  const ext = preset.format === "mp3" ? "mp3" : "wav";
  const filename = `${safeFilename(project.name)}_${isoDate()}_${preset.suffix}.${ext}`;
  report.filename = filename;
  report.fileBytes = blob.size;

  progress(1, "Done");
  return { blob, filename, report };
}

function round1(v) {
  return isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** Measure the current mix without exporting — powers the LUFS readout. */
export async function measureProject(project, takeCache, { applyChain = true } = {}) {
  const dur = projectDuration(project);
  if (dur <= 0) return { integrated: -Infinity, truePeak: -Infinity, durationSec: 0 };
  const buffer = await renderMix(project, takeCache, { applyChain, withLimiter: true });
  const channels = bufferChannels(buffer);
  const { integrated } = integratedLoudness(channels, buffer.sampleRate);
  return { integrated, truePeak: truePeakDb(channels), durationSec: buffer.duration };
}
