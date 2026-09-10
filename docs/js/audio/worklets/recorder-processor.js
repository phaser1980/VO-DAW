/**
 * recorder-processor.js — AudioWorklet mic capture.
 *
 * Runs on the audio thread. Its only jobs are (a) copy input blocks into a
 * chunk buffer and post them to the main thread, and (b) track the peak level
 * so the meter never has to pull an Analyser node. It allocates only when a
 * chunk is flushed, so the render quantum stays cheap.
 *
 * Deliberately a *sink*: it produces no output, so nothing here can create a
 * monitoring feedback loop. Monitoring is a separate, explicit node path.
 */

const CHUNK_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.channelCount = opts.channelCount || 1;
    this.recording = false;
    this.peak = 0;
    this.framesRecorded = 0;
    this._alloc();

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "start") {
        this.recording = true;
        this.framesRecorded = 0;
        this.fill = 0;
      } else if (msg.type === "stop") {
        this.flush(true);
        this.recording = false;
      }
    };
  }

  _alloc() {
    this.chunk = Array.from({ length: this.channelCount }, () => new Float32Array(CHUNK_FRAMES));
    this.fill = 0;
  }

  flush(final = false) {
    if (this.fill === 0) {
      if (final) this.port.postMessage({ type: "done", frames: this.framesRecorded });
      return;
    }
    // Slice to the used length and transfer — no copy on the main thread side.
    const payload = this.chunk.map((c) => c.slice(0, this.fill));
    this.port.postMessage(
      { type: "chunk", channels: payload, frames: this.fill },
      payload.map((p) => p.buffer),
    );
    this._alloc();
    if (final) this.port.postMessage({ type: "done", frames: this.framesRecorded });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;

    const frames = input[0].length;

    // Peak across whatever channels arrived, for the meter.
    let peak = 0;
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < frames; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i];
        if (a > peak) peak = a;
      }
    }
    // Decay so the meter falls back rather than sticking at a transient.
    this.peak = peak > this.peak ? peak : this.peak * 0.88;
    this.port.postMessage({ type: "level", peak: this.peak });

    if (!this.recording) return true;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channelCount; c++) {
        const src = input[Math.min(c, input.length - 1)];
        this.chunk[c][this.fill] = src[i];
      }
      this.fill++;
      this.framesRecorded++;
      if (this.fill >= CHUNK_FRAMES) this.flush();
    }

    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
