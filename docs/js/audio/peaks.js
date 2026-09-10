/**
 * peaks.js — waveform peak caching.
 *
 * Drawing a 10-minute take by walking 28 million samples per frame is not
 * viable, so each take gets a min/max peak pyramid built once at import time.
 * The timeline picks the level whose bucket size is closest to (but not
 * larger than) one screen pixel, then reads straight out of it.
 */

/** Bucket sizes in samples. ~1 ms at the bottom, ~1.5 s at the top. */
const LEVEL_BUCKETS = [64, 256, 1024, 4096, 16384, 65536];

/**
 * @param {Float32Array} mono
 * @returns {{levels: {bucket:number, min:Float32Array, max:Float32Array}[], length:number}}
 */
export function buildPeaks(mono) {
  const levels = [];
  let source = mono;
  let sourceBucket = 1;

  for (const bucket of LEVEL_BUCKETS) {
    const factor = bucket / sourceBucket;
    const count = Math.ceil(source.length / (levels.length ? factor : bucket));
    const min = new Float32Array(count);
    const max = new Float32Array(count);

    if (!levels.length) {
      // First level reads raw samples.
      for (let i = 0; i < count; i++) {
        const s = i * bucket;
        const e = Math.min(s + bucket, mono.length);
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = s; j < e; j++) {
          const v = mono[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        min[i] = lo === Infinity ? 0 : lo;
        max[i] = hi === -Infinity ? 0 : hi;
      }
    } else {
      // Later levels fold the level below, which is much cheaper.
      const prev = levels[levels.length - 1];
      for (let i = 0; i < count; i++) {
        const s = i * factor;
        const e = Math.min(s + factor, prev.min.length);
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = s; j < e; j++) {
          if (prev.min[j] < lo) lo = prev.min[j];
          if (prev.max[j] > hi) hi = prev.max[j];
        }
        min[i] = lo === Infinity ? 0 : lo;
        max[i] = hi === -Infinity ? 0 : hi;
      }
    }

    levels.push({ bucket, min, max });
    source = min; // only used for the length check below
    sourceBucket = bucket;
    if (count <= 1) break;
  }

  return { levels, length: mono.length };
}

/**
 * Read min/max pairs covering [startSample, endSample) into `columns` buckets.
 * Returns two Float32Arrays of length `columns`.
 */
export function readPeaks(peaks, startSample, endSample, columns) {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  if (!peaks || columns <= 0) return { min, max };

  const span = Math.max(1, endSample - startSample);
  const samplesPerColumn = span / columns;

  // Choose the coarsest level whose bucket still fits inside one column.
  let level = peaks.levels[0];
  for (const l of peaks.levels) {
    if (l.bucket <= samplesPerColumn) level = l;
    else break;
  }

  const { bucket, min: lmin, max: lmax } = level;
  for (let i = 0; i < columns; i++) {
    const s = Math.floor((startSample + i * samplesPerColumn) / bucket);
    const e = Math.max(s + 1, Math.ceil((startSample + (i + 1) * samplesPerColumn) / bucket));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = s; j < e && j < lmin.length; j++) {
      if (j < 0) continue;
      if (lmin[j] < lo) lo = lmin[j];
      if (lmax[j] > hi) hi = lmax[j];
    }
    min[i] = lo === Infinity ? 0 : lo;
    max[i] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}
