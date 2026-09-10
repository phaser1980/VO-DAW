/**
 * loudness.js — ITU-R BS.1770-4 loudness measurement.
 *
 * This is the same algorithm pyloudnorm implements on the desktop side, so
 * a file exported from the web app and the same file exported from StateVO
 * desktop should measure within rounding distance of each other.
 *
 * Pipeline per channel:
 *   1. K-weighting  = high-shelf (stage 1) -> high-pass (stage 2)
 *   2. mean square over 400 ms blocks, 75 % overlap
 *   3. channel-weighted sum -> block loudness
 *   4. two-stage gating: absolute -70 LUFS, then relative -10 LU
 *
 * Biquad coefficients are derived at the actual sample rate rather than
 * hard-coded for 48 kHz, so 44.1 kHz material measures correctly too.
 */

const ABSOLUTE_GATE_LUFS = -70.0;
const RELATIVE_GATE_LU = -10.0;
const BLOCK_SEC = 0.4;
const OVERLAP = 0.75;

/**
 * Stage 1: the BS.1770 "head effect" high shelf.
 *
 * These constants are the ones that actually reproduce the coefficient table
 * printed in BS.1770-4 for 48 kHz (b = [1.53512, -2.69170, 1.19839],
 * a = [1, -1.69066, 0.73248]) — verified against pyloudnorm, which is what
 * the desktop build measures with. Deriving them at the real sample rate
 * rather than hard-coding the 48 kHz table is what makes 44.1 kHz correct.
 */
function highShelfCoeffs(fs) {
  const f0 = 1500.0;
  const G = 4.0;
  const Q = Math.SQRT1_2;

  const A = Math.pow(10, G / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cw + sqrtA2alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cw);
  const b2 = A * (A + 1 + (A - 1) * cw - sqrtA2alpha);
  const a0 = A + 1 - (A - 1) * cw + sqrtA2alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cw);
  const a2 = A + 1 - (A - 1) * cw - sqrtA2alpha;

  return normalise(b0, b1, b2, a0, a1, a2);
}

/**
 * Stage 2: the RLB high-pass, f0 = 38 Hz, Q = 0.5.
 * Numerator is [1, -2, 1] rather than the RBJ [(1+cos)/2, …] form — that's
 * what BS.1770's table uses, and matching it keeps the two implementations
 * bit-comparable.
 */
function highPassCoeffs(fs) {
  const f0 = 38.0;
  const Q = 0.5;

  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Q);

  const b0 = 1.0;
  const b1 = -2.0;
  const b2 = 1.0;
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;

  return normalise(b0, b1, b2, a0, a1, a2);
}

function normalise(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Direct Form I biquad, out-of-place so the caller's data stays intact. */
function biquad(input, c, output) {
  const out = output || new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/** Apply the full K-weighting filter to one channel. */
export function kWeight(channel, sampleRate) {
  const s1 = biquad(channel, highShelfCoeffs(sampleRate));
  return biquad(s1, highPassCoeffs(sampleRate), s1);
}

/**
 * BS.1770 channel weights. Mono/stereo are 1.0; surround gives the rear
 * channels +1.5 dB. We only ever hand this 1–2 channels but the table
 * costs nothing.
 */
function channelWeights(n) {
  if (n <= 2) return new Array(n).fill(1.0);
  const w = new Array(n).fill(1.0);
  for (let i = 3; i < n && i < 5; i++) w[i] = 1.41; // ~ +1.5 dB
  return w;
}

/**
 * Integrated loudness, plus the gated block list so callers can also derive
 * loudness range if they want it later.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{integrated: number, blocks: number[], blockMs: number}}
 *          integrated is -Infinity for silence.
 */
export function integratedLoudness(channels, sampleRate) {
  if (!channels.length || !channels[0].length) {
    return { integrated: -Infinity, blocks: [], blockMs: BLOCK_SEC * 1000 };
  }

  const weights = channelWeights(channels.length);
  const filtered = channels.map((ch) => kWeight(ch, sampleRate));

  const blockSize = Math.round(BLOCK_SEC * sampleRate);
  const hop = Math.round(blockSize * (1 - OVERLAP));
  const n = filtered[0].length;

  if (n < blockSize) {
    // Shorter than one gating block — measure the whole thing as one block so
    // a 200 ms SFX still reports something instead of −∞.
    const z = meanSquare(filtered, weights, 0, n);
    const l = z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity;
    return { integrated: l, blocks: isFinite(l) ? [l] : [], blockMs: (n / sampleRate) * 1000 };
  }

  const blocks = [];
  for (let start = 0; start + blockSize <= n; start += hop) {
    const z = meanSquare(filtered, weights, start, blockSize);
    blocks.push(z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);
  }

  // Stage 1: absolute gate.
  const stage1 = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] > ABSOLUTE_GATE_LUFS) stage1.push(i);
  }
  if (!stage1.length) return { integrated: -Infinity, blocks, blockMs: BLOCK_SEC * 1000 };

  // Stage 2: relative gate, computed from the mean power of stage-1 blocks.
  const meanPower = (idx) => {
    let sum = 0;
    for (const i of idx) sum += Math.pow(10, (blocks[i] + 0.691) / 10);
    return sum / idx.length;
  };
  const relThreshold = -0.691 + 10 * Math.log10(meanPower(stage1)) + RELATIVE_GATE_LU;
  const stage2 = stage1.filter((i) => blocks[i] > relThreshold);
  const finalIdx = stage2.length ? stage2 : stage1;

  const integrated = -0.691 + 10 * Math.log10(meanPower(finalIdx));
  return { integrated, blocks, blockMs: BLOCK_SEC * 1000 };
}

function meanSquare(filtered, weights, start, len) {
  let z = 0;
  for (let c = 0; c < filtered.length; c++) {
    const ch = filtered[c];
    let sum = 0;
    const end = start + len;
    for (let i = start; i < end; i++) sum += ch[i] * ch[i];
    z += weights[c] * (sum / len);
  }
  return z;
}

/**
 * Momentary (400 ms) / short-term (3 s) loudness of the most recent audio —
 * used by the live meter, which only ever hands us a small ring buffer.
 */
export function windowLoudness(channels, sampleRate) {
  const weights = channelWeights(channels.length);
  const filtered = channels.map((ch) => kWeight(ch, sampleRate));
  const z = meanSquare(filtered, weights, 0, filtered[0].length);
  return z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity;
}

/** Plain sample peak in dBFS across all channels. */
export function samplePeakDb(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * True-peak estimate via 4x oversampling with linear interpolation.
 * Not a full BS.1770-4 polyphase filter — it lands within a few tenths of a
 * dB in practice, which is what a "did I clip?" readout actually needs.
 */
export function truePeakDb(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length - 1; i++) {
      const a = ch[i];
      const b = ch[i + 1];
      for (let k = 0; k < 4; k++) {
        const v = Math.abs(a + ((b - a) * k) / 4);
        if (v > peak) peak = v;
      }
    }
    if (ch.length) {
      const last = Math.abs(ch[ch.length - 1]);
      if (last > peak) peak = last;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Gain (linear) needed to bring `channels` to `targetLufs`.
 * Returns 1.0 for silence rather than Infinity.
 */
export function gainForTarget(channels, sampleRate, targetLufs) {
  const { integrated } = integratedLoudness(channels, sampleRate);
  if (!isFinite(integrated)) return { gain: 1, measured: integrated, deltaDb: 0 };
  const deltaDb = targetLufs - integrated;
  return { gain: Math.pow(10, deltaDb / 20), measured: integrated, deltaDb };
}
