/**
 * gate-processor.js — downward expander / noise gate.
 *
 * Web Audio has a compressor but no gate, and the cleanup stage of the voice
 * chain needs one: room tone and preamp hiss between phrases is what makes a
 * spoken-word bed sound amateur once a limiter pulls everything up.
 *
 * This is a soft downward expander rather than a hard gate — below threshold
 * the signal is attenuated by (ratio - 1) x the number of dB it sits under,
 * which fades room tone down instead of chopping it off. Attack/release/hold
 * are all in milliseconds. Runs identically in an OfflineAudioContext, so
 * export and monitoring share one implementation.
 */

class GateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.setParams(o);

    this.env = 0; // envelope follower, linear
    this.gain = 1; // current gain, linear
    this.holdCounter = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "params") this.setParams(e.data.params || {});
    };
  }

  setParams(p) {
    this.enabled = p.on !== false;
    this.thresholdDb = p.thresholdDb ?? -45;
    this.ratio = Math.max(1, p.ratio ?? 4);
    this.attackMs = Math.max(0.1, p.attackMs ?? 5);
    this.releaseMs = Math.max(1, p.releaseMs ?? 90);
    this.holdMs = Math.max(0, p.holdMs ?? 40);
    this.floorDb = p.floorDb ?? -60; // most attenuation the stage may apply

    this.threshold = Math.pow(10, this.thresholdDb / 20);
    this.floorGain = Math.pow(10, this.floorDb / 20);
    // Envelope follower is fast on the way up, slower on the way down.
    this.envAtt = Math.exp(-1 / ((0.5 / 1000) * sampleRate));
    this.envRel = Math.exp(-1 / ((30 / 1000) * sampleRate));
    this.gAtt = Math.exp(-1 / ((this.attackMs / 1000) * sampleRate));
    this.gRel = Math.exp(-1 / ((this.releaseMs / 1000) * sampleRate));
    this.holdSamples = Math.round((this.holdMs / 1000) * sampleRate);
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

    for (let i = 0; i < frames; i++) {
      // Detector: max across channels so a stereo bed gates as one unit.
      let x = 0;
      for (let c = 0; c < nCh; c++) {
        const a = Math.abs(input[c][i]);
        if (a > x) x = a;
      }

      const coef = x > this.env ? this.envAtt : this.envRel;
      this.env = x + coef * (this.env - x);

      // Target gain from a soft downward-expansion curve.
      let target;
      if (this.env >= this.threshold) {
        target = 1;
        this.holdCounter = this.holdSamples;
      } else if (this.holdCounter > 0) {
        target = 1;
        this.holdCounter--;
      } else {
        const envDb = 20 * Math.log10(Math.max(this.env, 1e-9));
        const belowDb = this.thresholdDb - envDb; // positive
        const reductionDb = -belowDb * (this.ratio - 1);
        target = Math.pow(10, reductionDb / 20);
        if (target < this.floorGain) target = this.floorGain;
      }

      const gc = target < this.gain ? this.gRel : this.gAtt;
      this.gain = target + gc * (this.gain - target);

      for (let c = 0; c < nCh; c++) output[c][i] = input[c][i] * this.gain;
    }

    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
