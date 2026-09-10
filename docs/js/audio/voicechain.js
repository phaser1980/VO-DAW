/**
 * voicechain.js — the fixed five-stage voice chain.
 *
 *   Cleanup (rumble filter + gate) -> De-esser -> Compressor -> EQ -> Limiter
 *
 * Built entirely from Web Audio nodes, which means the *same* graph runs for
 * live monitoring and for the offline export render. There is no separate
 * "export DSP" implementation to drift out of sync with what you heard.
 *
 * Bypassing a stage never rewires the graph — each stage has a neutral
 * parameter set that makes it mathematically transparent. Rewiring a live
 * graph clicks; setting a ratio to 1:1 doesn't.
 */

const GATE_URL = new URL("./worklets/gate-processor.js", import.meta.url);
const LIMITER_URL = new URL("./worklets/limiter-processor.js", import.meta.url);
const RECORDER_URL = new URL("./worklets/recorder-processor.js", import.meta.url);

const _loaded = new WeakSet();

/** Add every worklet module to a context exactly once. */
export async function ensureWorklets(ctx) {
  if (_loaded.has(ctx)) return;
  await Promise.all([
    ctx.audioWorklet.addModule(GATE_URL),
    ctx.audioWorklet.addModule(LIMITER_URL),
    ctx.audioWorklet.addModule(RECORDER_URL),
  ]);
  _loaded.add(ctx);
}

/**
 * @param {BaseAudioContext} ctx  online or OfflineAudioContext
 * @param {object} settings       project.voiceChain
 * @param {{channels?: number}} opts
 */
export function createVoiceChain(ctx, settings, opts = {}) {
  const channels = opts.channels || 2;

  // --- stage 1: cleanup -------------------------------------------------
  const rumble = ctx.createBiquadFilter();
  rumble.type = "highpass";
  rumble.frequency.value = 80;
  rumble.Q.value = 0.707;

  const gate = new AudioWorkletNode(ctx, "gate-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { ...settings.cleanup },
  });

  // --- stage 2: de-esser (phase-coherent band subtract/replace) ---------
  // out = full - highBand + compressedHighBand
  const deessSplit = ctx.createGain();
  const deessHP = ctx.createBiquadFilter();
  deessHP.type = "highpass";
  deessHP.frequency.value = settings.deesser.freqHz;
  deessHP.Q.value = 0.707;

  const deessInvert = ctx.createGain();
  deessInvert.gain.value = -1;

  const deessComp = ctx.createDynamicsCompressor();
  deessComp.threshold.value = settings.deesser.thresholdDb;
  deessComp.ratio.value = settings.deesser.ratio;
  deessComp.knee.value = 6;
  deessComp.attack.value = 0.001;
  deessComp.release.value = 0.05;

  const deessCompTrim = ctx.createGain();
  deessCompTrim.gain.value = 1;

  const deessSum = ctx.createGain();

  // --- stage 3: compressor ---------------------------------------------
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();

  // --- stage 4: EQ ------------------------------------------------------
  const eqHP = ctx.createBiquadFilter();
  eqHP.type = "highpass";
  eqHP.Q.value = 0.707;

  const eqLow = ctx.createBiquadFilter();
  eqLow.type = "lowshelf";

  const eqPresence = ctx.createBiquadFilter();
  eqPresence.type = "peaking";

  const eqAir = ctx.createBiquadFilter();
  eqAir.type = "highshelf";

  // --- stage 5: limiter -------------------------------------------------
  const limiter = new AudioWorkletNode(ctx, "limiter-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { ...settings.limiter },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();

  // --- wiring -----------------------------------------------------------
  input.connect(rumble);
  rumble.connect(gate);
  gate.connect(deessSplit);

  deessSplit.connect(deessSum); // dry/full path
  deessSplit.connect(deessHP);
  deessHP.connect(deessInvert);
  deessInvert.connect(deessSum); // subtract the raw high band
  deessHP.connect(deessComp);
  deessComp.connect(deessCompTrim);
  deessCompTrim.connect(deessSum); // add the tamed high band back

  deessSum.connect(comp);
  comp.connect(makeup);
  makeup.connect(eqHP);
  eqHP.connect(eqLow);
  eqLow.connect(eqPresence);
  eqPresence.connect(eqAir);
  eqAir.connect(limiter);
  limiter.connect(output);

  const nodes = {
    rumble, gate,
    deessHP, deessInvert, deessComp, deessCompTrim,
    comp, makeup,
    eqHP, eqLow, eqPresence, eqAir,
    limiter,
  };

  /** Push a full settings object into the live graph. */
  function setParams(s) {
    const t = ctx.currentTime;
    const set = (p, v) => {
      // setTargetAtTime on an offline context with a 0 time constant is fine,
      // but a plain assignment is what we want for a render that hasn't
      // started yet. Ramp only when the context is actually running.
      if (ctx.state === "running") p.setTargetAtTime(v, t, 0.01);
      else p.value = v;
    };

    // 1. cleanup
    set(nodes.rumble.frequency, s.cleanup.on ? s.cleanup.highpassHz : 10);
    nodes.gate.port.postMessage({ type: "params", params: { ...s.cleanup } });

    // 2. de-esser — gain 0 on both side paths is a true bypass
    const dsOn = s.deesser.on ? 1 : 0;
    set(nodes.deessHP.frequency, s.deesser.freqHz);
    nodes.deessComp.threshold.value = s.deesser.thresholdDb;
    nodes.deessComp.ratio.value = s.deesser.ratio;
    set(nodes.deessInvert.gain, -dsOn);
    set(nodes.deessCompTrim.gain, dsOn);

    // 3. compressor — ratio 1:1 is transparent
    nodes.comp.threshold.value = s.compressor.on ? s.compressor.thresholdDb : 0;
    nodes.comp.ratio.value = s.compressor.on ? s.compressor.ratio : 1;
    nodes.comp.knee.value = 6;
    nodes.comp.attack.value = Math.max(0, s.compressor.attackMs / 1000);
    nodes.comp.release.value = Math.max(0.01, s.compressor.releaseMs / 1000);
    set(nodes.makeup.gain, s.compressor.on ? Math.pow(10, s.compressor.makeupDb / 20) : 1);

    // 4. EQ — flat gains and a 10 Hz HP is transparent
    const eqOn = s.eq.on;
    set(nodes.eqHP.frequency, eqOn ? s.eq.highpassHz : 10);
    set(nodes.eqLow.frequency, s.eq.lowShelf.freqHz);
    set(nodes.eqLow.gain, eqOn ? s.eq.lowShelf.gainDb : 0);
    set(nodes.eqPresence.frequency, s.eq.presence.freqHz);
    set(nodes.eqPresence.gain, eqOn ? s.eq.presence.gainDb : 0);
    nodes.eqPresence.Q.value = s.eq.presence.q;
    set(nodes.eqAir.frequency, s.eq.air.freqHz);
    set(nodes.eqAir.gain, eqOn ? s.eq.air.gainDb : 0);

    // 5. limiter
    nodes.limiter.port.postMessage({ type: "params", params: { ...s.limiter } });
  }

  setParams(settings);

  /** Called by the export path — render without the limiter so loudness
   *  normalisation happens before the ceiling is enforced. */
  function setLimiterEnabled(on) {
    nodes.limiter.port.postMessage({ type: "params", params: { ...settings.limiter, on } });
  }

  function onGainReduction(cb) {
    nodes.limiter.port.onmessage = (e) => {
      if (e.data?.type === "gr") cb(e.data.reductionDb);
    };
  }

  function dispose() {
    try {
      input.disconnect();
      output.disconnect();
      for (const n of Object.values(nodes)) n.disconnect?.();
      nodes.gate.port.close?.();
      nodes.limiter.port.close?.();
    } catch {
      /* already torn down */
    }
  }

  return { input, output, nodes, setParams, setLimiterEnabled, onGainReduction, dispose };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The one-click presets. These are data, not scattered magic numbers — the
 * single place "what does StateVO do by default" lives.
 */
export const VOICE_PRESETS = {
  social: {
    label: "Social / Reels",
    hint: "Forward, dense, survives a phone speaker",
    apply: (vc) => {
      vc.cleanup = { ...vc.cleanup, on: true, thresholdDb: -45, ratio: 4, releaseMs: 90, highpassHz: 85 };
      vc.deesser = { ...vc.deesser, on: true, freqHz: 6500, thresholdDb: -26, ratio: 4 };
      vc.compressor = { ...vc.compressor, on: true, thresholdDb: -20, ratio: 3.5, attackMs: 6, releaseMs: 120, makeupDb: 4 };
      vc.eq = {
        ...vc.eq, on: true, highpassHz: 95,
        lowShelf: { freqHz: 200, gainDb: -2 },
        presence: { freqHz: 3400, gainDb: 3, q: 0.9 },
        air: { freqHz: 11000, gainDb: 2 },
      };
      vc.limiter = { ...vc.limiter, on: true, ceilingDb: -1.0, releaseMs: 50 };
    },
  },
  podcast: {
    label: "Podcast",
    hint: "Natural, roomy, easy on the ears for an hour",
    apply: (vc) => {
      vc.cleanup = { ...vc.cleanup, on: true, thresholdDb: -50, ratio: 3, releaseMs: 140, highpassHz: 75 };
      vc.deesser = { ...vc.deesser, on: true, freqHz: 7000, thresholdDb: -24, ratio: 3 };
      vc.compressor = { ...vc.compressor, on: true, thresholdDb: -22, ratio: 2.5, attackMs: 10, releaseMs: 180, makeupDb: 3 };
      vc.eq = {
        ...vc.eq, on: true, highpassHz: 80,
        lowShelf: { freqHz: 180, gainDb: -1 },
        presence: { freqHz: 3000, gainDb: 1.5, q: 0.8 },
        air: { freqHz: 10000, gainDb: 1 },
      };
      vc.limiter = { ...vc.limiter, on: true, ceilingDb: -1.5, releaseMs: 80 };
    },
  },
  raw: {
    label: "Raw",
    hint: "Chain off — what the mic actually heard",
    apply: (vc) => {
      vc.cleanup = { ...vc.cleanup, on: false };
      vc.deesser = { ...vc.deesser, on: false };
      vc.compressor = { ...vc.compressor, on: false };
      vc.eq = { ...vc.eq, on: false };
      vc.limiter = { ...vc.limiter, on: false };
    },
  },
};

export function applyPreset(voiceChain, presetId) {
  const preset = VOICE_PRESETS[presetId];
  if (!preset) return voiceChain;
  preset.apply(voiceChain);
  voiceChain.preset = presetId;
  return voiceChain;
}
