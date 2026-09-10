/**
 * limiter-processor.js — lookahead brickwall limiter.
 *
 * The final stage of the voice chain and the thing that makes "-14 LUFS with
 * a -1 dBTP ceiling" actually true. A DynamicsCompressor with a high ratio is
 * not a substitute: without lookahead it lets the transient through and then
 * ducks, which on speech reads as a lisp on plosives.
 *
 * Implementation: an N-sample delay line for the signal, a gain envelope
 * computed from the *undelayed* peak (so gain reduction is fully applied by
 * the time the loud sample reaches the output), attack tied to the lookahead
 * window and an exponential release.
 *
 * Reports its running gain reduction back to the main thread so the UI can
 * show how hard it's working.
 */

const LOOKAHEAD_MS = 5;

class LimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.lookahead = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate));
    this.delay = null;
    this.writeIdx = 0;
    this.gain = 1;
    this.maxReduction = 0; // dB, reported and reset each poll
    this.reportCounter = 0;

    this.setParams(o);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "params") this.setParams(d.params || {});
      else if (d.type === "reset") this.maxReduction = 0;
    };
  }

  setParams(p) {
    this.enabled = p.on !== false;
    this.ceilingDb = p.ceilingDb ?? -1.0;
    this.releaseMs = Math.max(1, p.releaseMs ?? 60);
    this.ceiling = Math.pow(10, this.ceilingDb / 20);
    // Reach full gain reduction across the lookahead window.
    this.att = Math.exp(-1 / this.lookahead);
    this.rel = Math.exp(-1 / ((this.releaseMs / 1000) * sampleRate));
  }

  _ensureDelay(nCh) {
    if (this.delay && this.delay.length === nCh) return;
    this.delay = Array.from({ length: nCh }, () => new Float32Array(this.lookahead));
    this.writeIdx = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const frames = output[0].length;
    const nCh = Math.min(input.length, output.length);

    if (!this.enabled) {
      for (let c = 0; c < nCh; c++) output[c].set(input[c]);
      return true;
    }

    this._ensureDelay(nCh);

    for (let i = 0; i < frames; i++) {
      // Peak of the incoming (lookahead) sample across channels.
      let x = 0;
      for (let c = 0; c < nCh; c++) {
        const a = Math.abs(input[c][i]);
        if (a > x) x = a;
      }

      const target = x > this.ceiling ? this.ceiling / x : 1;
      const coef = target < this.gain ? this.att : this.rel;
      this.gain = target + coef * (this.gain - target);

      const reduction = -20 * Math.log10(Math.max(this.gain, 1e-9));
      if (reduction > this.maxReduction) this.maxReduction = reduction;

      // Read the delayed sample, then overwrite that slot with the new one.
      const idx = this.writeIdx;
      for (let c = 0; c < nCh; c++) {
        const delayed = this.delay[c][idx];
        this.delay[c][idx] = input[c][i];
        let y = delayed * this.gain;
        // Safety clip — the envelope can overshoot by a hair on pathological
        // material, and a sample over full scale defeats the whole point.
        if (y > this.ceiling) y = this.ceiling;
        else if (y < -this.ceiling) y = -this.ceiling;
        output[c][i] = y;
      }
      this.writeIdx = (idx + 1) % this.lookahead;
    }

    // ~20 Hz reporting is plenty for a GR meter.
    this.reportCounter += frames;
    if (this.reportCounter >= sampleRate / 20) {
      this.reportCounter = 0;
      this.port.postMessage({ type: "gr", reductionDb: this.maxReduction });
      this.maxReduction = 0;
    }

    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
