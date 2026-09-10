/**
 * wav.js — RIFF/WAVE encode + decode.
 *
 * We store every take as a WAV blob so the project folder stays inspectable
 * (the same "non-destructive, human-readable" guarantee the desktop app makes)
 * and so exports don't need a second codec path for the lossless case.
 *
 * Encode supports 16-bit and 24-bit PCM plus 32-bit float.
 * Decode handles the PCM/float subset that browsers and ffmpeg emit; anything
 * exotic falls back to the browser's own decodeAudioData in engine.js.
 */

/**
 * @param {Float32Array[]} channels  one Float32Array per channel, equal length
 * @param {number} sampleRate
 * @param {16|24|32} bitDepth  32 means 32-bit float
 * @returns {Blob}
 */
export function encodeWav(channels, sampleRate, bitDepth = 24) {
  const numCh = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const isFloat = bitDepth === 32;
  const bytesPerSample = isFloat ? 4 : bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataBytes = numFrames * blockAlign;

  // fmt chunk is 16 bytes for PCM, 18 for IEEE float (cbSize=0 required by spec)
  const fmtSize = isFloat ? 18 : 16;
  const headerBytes = 12 + (8 + fmtSize) + (isFloat ? 12 : 0) + 8;
  const buf = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buf);
  let o = 0;

  const str = (s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (v) => {
    view.setUint32(o, v, true);
    o += 4;
  };
  const u16 = (v) => {
    view.setUint16(o, v, true);
    o += 2;
  };

  str("RIFF");
  u32(buf.byteLength - 8);
  str("WAVE");

  str("fmt ");
  u32(fmtSize);
  u16(isFloat ? 3 : 1); // 3 = IEEE float, 1 = PCM
  u16(numCh);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(isFloat ? 32 : bitDepth);
  if (isFloat) u16(0); // cbSize

  if (isFloat) {
    str("fact");
    u32(4);
    u32(numFrames);
  }

  str("data");
  u32(dataBytes);

  // Interleave + quantise.
  if (isFloat) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        view.setFloat32(o, channels[c][i], true);
        o += 4;
      }
    }
  } else if (bitDepth === 16) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
  } else {
    // 24-bit little-endian
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        if (v < 0) v += 0x1000000;
        view.setUint8(o++, v & 0xff);
        view.setUint8(o++, (v >> 8) & 0xff);
        view.setUint8(o++, (v >> 16) & 0xff);
      }
    }
  }

  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Minimal WAV parser. Returns null if this isn't a WAV we recognise, so the
 * caller can fall back to the browser decoder.
 * @returns {{channels: Float32Array[], sampleRate: number} | null}
 */
export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 44) return null;
  const tag = (off) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let o = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (o + 8 <= arrayBuffer.byteLength) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE — the real format sits in the subformat GUID
      if (fmt.format === 0xfffe && size >= 40) {
        fmt.format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, arrayBuffer.byteLength - body);
    }
    o = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || dataOffset < 0) return null;
  const { channels: numCh, sampleRate, bitsPerSample, format } = fmt;
  if (!numCh || !sampleRate) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * numCh));
  const out = Array.from({ length: numCh }, () => new Float32Array(frames));

  if (format === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numCh; c++)
        out[c][i] = view.getFloat32(dataOffset + (i * numCh + c) * 4, true);
  } else if (format === 1 && bitsPerSample === 16) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numCh; c++)
        out[c][i] = view.getInt16(dataOffset + (i * numCh + c) * 2, true) / 0x8000;
  } else if (format === 1 && bitsPerSample === 24) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numCh; c++) {
        const p = dataOffset + (i * numCh + c) * 3;
        let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        out[c][i] = v / 0x800000;
      }
  } else if (format === 1 && bitsPerSample === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numCh; c++)
        out[c][i] = view.getInt32(dataOffset + (i * numCh + c) * 4, true) / 0x80000000;
  } else if (format === 1 && bitsPerSample === 8) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numCh; c++)
        out[c][i] = (view.getUint8(dataOffset + i * numCh + c) - 128) / 128;
  } else {
    return null; // unknown — let decodeAudioData try
  }

  return { channels: out, sampleRate };
}

/** Pull an AudioBuffer's channels out as plain Float32Arrays. */
export function bufferToChannels(audioBuffer) {
  const out = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) out.push(audioBuffer.getChannelData(c));
  return out;
}

/** Downmix N channels to mono (simple average). */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += channels[c][i];
    out[i] = s / channels.length;
  }
  return out;
}
