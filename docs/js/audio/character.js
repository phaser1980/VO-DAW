/**
 * character.js — per-track "character" effects: Phone and Hall/PA.
 *
 * These are optional, one-per-voice-track inserts that sit *before* the
 * shared polish chain (see engine.js `play()` / render.js `renderMix()`):
 *
 *   clip -> track fader -> [character FX] -> polish chain -> master
 *
 * That order matters: the character effect emulates something that happened
 * to the voice before it reached your mic (a phone line, a big room), so it
 * belongs upstream of the chain that cleans up *your* capture of it — not
 * layered on top of already-gated/compressed/EQ'd audio.
 *
 * Built from native Web Audio nodes only, same as the rest of the chain, so
 * it works identically in the live AudioContext and an OfflineAudioContext
 * export render — no assets to fetch, nothing to keep in sync by hand.
 */

import { dbToGain, clamp } from "../util.js";

/**
 * Per-type sweet spots — Phone's "on a rough line" character and Hall's
 * "big room" character land at different points on a 0..1 dial, so a
 * default that's right for one is off for the other. Used as the starting
 * amount whenever a track's Character is switched to that type.
 */
export const DEFAULT_AMOUNT = { none: 0.6, phone: 0.75, hall: 0.5 };

/**
 * @param {BaseAudioContext} ctx
 * @param {"none"|"phone"|"hall"} type
 * @param {number} amount  0..1
 * @returns {{input: AudioNode, output: AudioNode, setAmount: (v:number)=>void, dispose: ()=>void}}
 */
export function createCharacterFX(ctx, type, amount = DEFAULT_AMOUNT.none) {
  if (type === "phone") return createPhoneFX(ctx, amount);
  if (type === "hall") return createHallFX(ctx, amount);
  return createPassthroughFX(ctx);
}

function createPassthroughFX(ctx) {
  const node = ctx.createGain();
  return {
    input: node,
    output: node,
    setAmount() {},
    dispose() {
      try { node.disconnect(); } catch { /* already torn down */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phone — telephone voice-band, amount = how narrow/gritty            */
/* ------------------------------------------------------------------ */

/**
 * Two cascaded highpass + two cascaded lowpass stages give a steeper,
 * more convincing band edge than a single bandpass node. Amount narrows
 * the band and adds saturation/compression — always close to fully wet,
 * since a real phone line doesn't leave the full-band voice audible
 * underneath; blending dry back in would just undo the illusion.
 */
function createPhoneFX(ctx, amount) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const hp1 = ctx.createBiquadFilter();
  hp1.type = "highpass";
  hp1.Q.value = 0.8;
  const hp2 = ctx.createBiquadFilter();
  hp2.type = "highpass";
  hp2.Q.value = 0.8;
  const lp1 = ctx.createBiquadFilter();
  lp1.type = "lowpass";
  lp1.Q.value = 0.8;
  const lp2 = ctx.createBiquadFilter();
  lp2.type = "lowpass";
  lp2.Q.value = 0.8;

  const shaper = ctx.createWaveShaper();
  shaper.oversample = "2x";

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.ratio.value = 6;
  comp.knee.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.08;

  const makeup = ctx.createGain();

  input.connect(hp1);
  hp1.connect(hp2);
  hp2.connect(lp1);
  lp1.connect(lp2);
  lp2.connect(shaper);
  shaper.connect(comp);
  comp.connect(makeup);
  makeup.connect(output);

  function apply(a) {
    a = clamp(a, 0, 1);
    const hpHz = 180 + a * 270; // 180 -> 450 Hz: mild -> starkly narrow
    const lpHz = 4500 - a * 1700; // 4500 -> 2800 Hz
    hp1.frequency.value = hpHz;
    hp2.frequency.value = hpHz;
    lp1.frequency.value = lpHz;
    lp2.frequency.value = lpHz;
    shaper.curve = softClipCurve(0.15 + a * 0.6);
    makeup.gain.value = dbToGain(1 + a * 2); // the band cut loses level; claw a bit back
  }
  apply(amount);

  const nodes = [input, output, hp1, hp2, lp1, lp2, shaper, comp, makeup];
  return {
    input,
    output,
    setAmount: apply,
    dispose() {
      for (const n of nodes) {
        try { n.disconnect(); } catch { /* already torn down */ }
      }
    },
  };
}

function softClipCurve(drive, samples = 256) {
  const curve = new Float32Array(samples);
  const k = Math.max(0.0001, drive) * 20;
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/* ------------------------------------------------------------------ */
/* Hall — predelay + synthesised convolution tail, amount = wet/dry    */
/* ------------------------------------------------------------------ */

/**
 * No impulse-response asset to fetch, so the tail is synthesised: noise
 * shaped by an exponential decay envelope, then lightly smoothed (a cheap
 * one-pole pass) so it reads as a diffuse room rather than digital hiss.
 * Independent noise per channel widens it instead of leaving a mono blob
 * dead-centre.
 */
function buildHallImpulse(ctx, { durationSec = 1.8, decay = 3.2 } = {}) {
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sr * durationSec));
  const buffer = ctx.createBuffer(2, length, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const env = Math.exp(-decay * t);
      const raw = (Math.random() * 2 - 1) * env;
      smooth = smooth * 0.6 + raw * 0.4;
      data[i] = smooth;
    }
  }
  return buffer;
}

function createHallFX(ctx, amount) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();

  const predelay = ctx.createDelay(0.2);
  predelay.delayTime.value = 0.04; // that "bounced off the back wall" gap

  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = buildHallImpulse(ctx);

  // Real room tails lose high frequency to air/absorption — without this the
  // reverb reads as a clean plate, not a big physical space.
  const damp = ctx.createBiquadFilter();
  damp.type = "highshelf";
  damp.frequency.value = 4000;
  damp.gain.value = -9;

  input.connect(dry);
  dry.connect(output);
  input.connect(predelay);
  predelay.connect(convolver);
  convolver.connect(damp);
  damp.connect(wet);
  wet.connect(output);

  function apply(a) {
    a = clamp(a, 0, 1);
    // Never fully kill the dry signal — even at max amount the words need to
    // stay intelligible, not dissolve into the tail.
    dry.gain.value = 1 - a * 0.85;
    wet.gain.value = a;
  }
  apply(amount);

  const nodes = [input, output, dry, wet, predelay, convolver, damp];
  return {
    input,
    output,
    setAmount: apply,
    dispose() {
      for (const n of nodes) {
        try { n.disconnect(); } catch { /* already torn down */ }
      }
    },
  };
}
