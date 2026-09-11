/**
 * peaks-worker.js — off-main-thread mono downmix, peak pyramid, and a
 * loudness pre-measurement, all in one pass.
 *
 * Importing a multi-minute SFX used to stall the main thread building peaks
 * synchronously (toMono + buildPeaks over the whole take); measuring
 * integrated loudness for auto-level-on-drop is the same shape of problem —
 * K-weighting + gating over every sample is no cheaper than the peak
 * pyramid. Both run here instead, off the main thread, using the channel
 * copies that are already being transferred in for peaks. Everything comes
 * back already computed, so a fresh import never has to filter the whole
 * take again on the main thread just to suggest a level.
 */
import { toMono } from "./wav.js";
import { buildPeaks } from "./peaks.js";
import { integratedLoudness, samplePeakDb } from "./loudness.js";

self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  const mono = toMono(channels);
  const peaks = buildPeaks(mono);
  const { integrated } = integratedLoudness(channels, sampleRate);
  const peakDb = samplePeakDb(channels);

  const transfer = [mono.buffer];
  for (const level of peaks.levels) transfer.push(level.min.buffer, level.max.buffer);
  self.postMessage({ id, mono, peaks, integrated, peakDb }, transfer);
};
