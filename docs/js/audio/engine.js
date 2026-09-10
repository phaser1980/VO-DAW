/**
 * engine.js — recording, playback and take management.
 *
 * Owns the single AudioContext. Everything that needs to make or hear sound
 * goes through here; the UI never touches Web Audio directly.
 *
 * Canonical-format rule (borrowed straight from the desktop app's
 * media_import.py): whatever comes in — a recording, an mp3 dropped from
 * Explorer, an SFX pull from Freesound — is decoded and re-encoded as WAV at
 * the project sample rate before it is stored. One predictable format on
 * disk, so nothing downstream has to care where a clip came from.
 */

import { encodeWav, toMono } from "./wav.js";
import { buildPeaks } from "./peaks.js";
import { ensureWorklets, createVoiceChain } from "./voicechain.js";
import { makeTake } from "../model.js";
import { putAudio, getAudio } from "../storage.js";
import { uid, clamp, dbToGain } from "../util.js";
import { audibleTracks, clipDuration, clipEnd } from "../model.js";

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stream = null;
    this.sourceNode = null;
    this.inputGain = null;
    this.recorderNode = null;
    this.monitorGain = null;
    this.masterGain = null;
    this.analyser = null;
    this.chain = null;
    this.chainEnabled = false;

    this.recording = false;
    this._recChunks = [];
    this._recFrames = 0;
    this._recChannels = 1;
    this._recStartCtxTime = 0;
    this._recResolve = null;

    this.playing = false;
    this._playNodes = [];
    this._playStartCtx = 0;
    this._playStartSec = 0;
    this._playStopAt = null;

    this.inputPeak = 0;
    /** takeId -> { buffer: AudioBuffer, peaks, mono: Float32Array } */
    this.cache = new Map();
  }

  /* ------------------------------------------------------------------ */
  /* Context                                                             */
  /* ------------------------------------------------------------------ */

  get sampleRate() {
    return this.ctx?.sampleRate || 48000;
  }

  /** Must be called from a user gesture the first time. */
  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    await ensureWorklets(this.ctx);

    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._analyserBuf = new Float32Array(this.analyser.fftSize);
    return this.ctx;
  }

  /** Peak of the playback bus, for the output meter. */
  outputPeak() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._analyserBuf);
    let p = 0;
    for (let i = 0; i < this._analyserBuf.length; i++) {
      const a = Math.abs(this._analyserBuf[i]);
      if (a > p) p = a;
    }
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Input device / arming                                               */
  /* ------------------------------------------------------------------ */

  async listInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  }

  /**
   * Open the mic and wire input -> gain -> recorder worklet.
   * Browser DSP (AGC, noise suppression, echo cancel) is switched off — this
   * is a DAW, the voice chain is where processing is supposed to happen.
   */
  async arm(deviceId = null) {
    await this.ensureContext();
    if (this.stream) this.disarm();

    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    const track = this.stream.getAudioTracks()[0];
    this._recChannels = 1;

    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.inputGain = this.ctx.createGain();
    this.inputGain.gain.value = 1;

    this.recorderNode = new AudioWorkletNode(this.ctx, "recorder-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { channelCount: this._recChannels },
    });
    this.recorderNode.port.onmessage = (e) => this._onRecorderMessage(e.data);

    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0; // monitoring off by default — feedback

    this.sourceNode.connect(this.inputGain);
    this.inputGain.connect(this.recorderNode);
    this.inputGain.connect(this.monitorGain);
    this.monitorGain.connect(this.masterGain);

    this.dispatchEvent(new CustomEvent("armed", { detail: { label: track?.label || "" } }));
    return track?.label || "";
  }

  disarm() {
    try {
      this.recorderNode?.disconnect();
      this.inputGain?.disconnect();
      this.sourceNode?.disconnect();
      this.monitorGain?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* nothing to tear down */
    }
    this.stream = null;
    this.sourceNode = null;
    this.recorderNode = null;
    this.inputPeak = 0;
    this.dispatchEvent(new CustomEvent("disarmed"));
  }

  get armed() {
    return !!this.stream;
  }

  setInputGainDb(db) {
    if (this.inputGain) this.inputGain.gain.value = dbToGain(db);
  }

  setMonitoring(on, levelDb = -6) {
    if (this.monitorGain) this.monitorGain.gain.value = on ? dbToGain(levelDb) : 0;
  }

  _onRecorderMessage(msg) {
    if (msg.type === "level") {
      this.inputPeak = msg.peak;
    } else if (msg.type === "chunk") {
      this._recChunks.push(msg.channels);
      this._recFrames += msg.frames;
    } else if (msg.type === "done") {
      this._recResolve?.();
      this._recResolve = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Recording                                                           */
  /* ------------------------------------------------------------------ */

  startRecording() {
    if (!this.armed) throw new Error("No input armed");
    this._recChunks = [];
    this._recFrames = 0;
    this._recStartCtxTime = this.ctx.currentTime;
    this.recording = true;
    this.recorderNode.port.postMessage({ type: "start" });
    this.dispatchEvent(new CustomEvent("recordstart"));
  }

  get elapsedRecordingSec() {
    if (!this.recording) return 0;
    return this.ctx.currentTime - this._recStartCtxTime;
  }

  /**
   * Stop, assemble the take, store it as WAV, and return the Take record.
   * @returns {Promise<{take: object, buffer: AudioBuffer}>}
   */
  async stopRecording(name = "Take") {
    if (!this.recording) return null;
    const done = new Promise((res) => (this._recResolve = res));
    this.recorderNode.port.postMessage({ type: "stop" });
    this.recording = false;
    await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
    this.dispatchEvent(new CustomEvent("recordstop"));

    if (!this._recFrames) return null;

    const nCh = this._recChannels;
    const channels = Array.from({ length: nCh }, () => new Float32Array(this._recFrames));
    let offset = 0;
    for (const chunk of this._recChunks) {
      const len = chunk[0].length;
      for (let c = 0; c < nCh; c++) channels[c].set(chunk[c], offset);
      offset += len;
    }
    this._recChunks = [];

    const sr = this.ctx.sampleRate;
    const take = makeTake({
      name,
      sampleRate: sr,
      channels: nCh,
      durationSec: this._recFrames / sr,
      source: "record",
    });

    const blob = encodeWav(channels, sr, 24);
    await putAudio(take.id, blob, { name, source: "record" });

    const buffer = this.ctx.createBuffer(nCh, this._recFrames, sr);
    for (let c = 0; c < nCh; c++) buffer.copyToChannel(channels[c], c);
    this._cacheTake(take.id, buffer);

    return { take, buffer };
  }

  /* ------------------------------------------------------------------ */
  /* Import                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Decode any browser-supported audio (wav/mp3/ogg/flac/m4a), resample to the
   * project rate, store as WAV, and return a Take.
   * @param {Blob|ArrayBuffer} data
   */
  async importAudio(data, { name = "Audio", source = "file", meta = {} } = {}) {
    await this.ensureContext();
    const arrayBuffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();

    let decoded;
    try {
      decoded = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      throw new Error(`Could not decode "${name}" — unsupported or corrupt audio.`);
    }

    // Cap at stereo. A 5.1 SFX pull would just waste storage here.
    const nCh = Math.min(decoded.numberOfChannels, 2);
    const channels = [];
    for (let c = 0; c < nCh; c++) channels.push(decoded.getChannelData(c));

    const take = makeTake({
      name,
      sampleRate: decoded.sampleRate,
      channels: nCh,
      durationSec: decoded.duration,
      source,
      meta,
    });

    const blob = encodeWav(channels, decoded.sampleRate, 24);
    await putAudio(take.id, blob, { name, source });

    // decodeAudioData already resampled to ctx.sampleRate, so this buffer is
    // playback-ready as-is.
    this._cacheTake(take.id, decoded);
    return { take, buffer: decoded };
  }

  _cacheTake(takeId, buffer) {
    const mono = toMono(
      Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
    );
    this.cache.set(takeId, { buffer, mono, peaks: buildPeaks(mono) });
    return this.cache.get(takeId);
  }

  /** Load (and cache) a take's audio. Returns null if the blob is gone. */
  async getTakeAudio(takeId) {
    if (this.cache.has(takeId)) return this.cache.get(takeId);
    const blob = await getAudio(takeId);
    if (!blob) return null;
    await this.ensureContext();
    const ab = await blob.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(ab);
    return this._cacheTake(takeId, buffer);
  }

  /** Warm the cache for everything a project references. */
  async preloadProject(project) {
    const ids = new Set();
    for (const t of project.tracks) for (const c of t.clips) ids.add(c.takeId);
    const missing = [];
    for (const id of ids) {
      const got = await this.getTakeAudio(id);
      if (!got) missing.push(id);
    }
    return missing;
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Schedule every clip that overlaps [fromSec, ...) and start.
   * @param {object} project
   * @param {number} fromSec
   * @param {{toSec?: number, throughChain?: boolean}} opts
   */
  async play(project, fromSec = 0, opts = {}) {
    await this.ensureContext();
    this.stop();

    const tracks = audibleTracks(project);
    const now = this.ctx.currentTime + 0.06; // small pre-roll for scheduling
    this._playStartCtx = now;
    this._playStartSec = fromSec;
    this._playStopAt = opts.toSec ?? null;

    // Optional monitoring through the voice chain.
    let destination = this.masterGain;
    if (opts.throughChain) {
      this._ensureChain(project.voiceChain);
      this.chain.output.connect(this.masterGain);
      destination = this.chain.input;
    }

    let scheduled = 0;
    for (const track of tracks) {
      const trackGain = this.ctx.createGain();
      trackGain.gain.value = dbToGain(track.volumeDb);
      // Only the voice track goes through the chain; beds/SFX stay clean.
      trackGain.connect(track.kind === "voice" ? destination : this.masterGain);
      this._playNodes.push(trackGain);

      for (const clip of track.clips) {
        const dur = clipDuration(clip);
        if (dur <= 0) continue;
        const end = clipEnd(clip);
        if (end <= fromSec) continue;
        if (this._playStopAt !== null && clip.startSec >= this._playStopAt) continue;

        const cached = this.cache.get(clip.takeId);
        if (!cached) continue;

        const startsIn = Math.max(0, clip.startSec - fromSec);
        const skip = Math.max(0, fromSec - clip.startSec);
        let playDur = dur - skip;
        if (this._playStopAt !== null) {
          playDur = Math.min(playDur, this._playStopAt - Math.max(clip.startSec, fromSec));
        }
        if (playDur <= 0) continue;

        const src = this.ctx.createBufferSource();
        src.buffer = cached.buffer;
        const g = this.ctx.createGain();
        this._applyClipEnvelope(g, clip, now + startsIn, skip, playDur);

        src.connect(g);
        g.connect(trackGain);
        src.start(now + startsIn, clip.sourceInSec + skip, playDur);
        this._playNodes.push(src, g);
        scheduled++;
      }
    }

    this.playing = true;
    this.dispatchEvent(new CustomEvent("playstart", { detail: { fromSec, scheduled } }));

    if (this._playStopAt !== null) {
      const ms = (this._playStopAt - fromSec) * 1000 + 120;
      this._stopTimer = setTimeout(() => this.stop(), Math.max(0, ms));
    }
    return scheduled;
  }

  /** Clip gain + fade in/out as a scheduled envelope on `g`. */
  _applyClipEnvelope(g, clip, startAt, skip, playDur) {
    const base = dbToGain(clip.gainDb);
    const fi = Math.max(0, clip.fadeInSec - skip);
    const dur = clipDuration(clip);
    const fadeOutStart = Math.max(0, dur - clip.fadeOutSec - skip);

    g.gain.cancelScheduledValues(startAt);
    if (fi > 0) {
      g.gain.setValueAtTime(0.0001, startAt);
      g.gain.exponentialRampToValueAtTime(base, startAt + fi);
    } else {
      g.gain.setValueAtTime(base, startAt);
    }
    if (clip.fadeOutSec > 0 && fadeOutStart < playDur) {
      g.gain.setValueAtTime(base, startAt + fadeOutStart);
      g.gain.exponentialRampToValueAtTime(
        0.0001,
        startAt + Math.min(playDur, fadeOutStart + clip.fadeOutSec),
      );
    }
  }

  _ensureChain(settings) {
    if (this.chain) {
      this.chain.setParams(settings);
      return this.chain;
    }
    this.chain = createVoiceChain(this.ctx, settings, { channels: 2 });
    return this.chain;
  }

  updateChain(settings) {
    if (this.chain) this.chain.setParams(settings);
  }

  stop() {
    clearTimeout(this._stopTimer);
    for (const n of this._playNodes) {
      try {
        if (n.stop) n.stop();
        n.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this._playNodes = [];
    if (this.chain) {
      try {
        this.chain.output.disconnect(this.masterGain);
      } catch {
        /* not connected */
      }
    }
    if (this.playing) {
      this.playing = false;
      this.dispatchEvent(new CustomEvent("playstop"));
    }
  }

  /** Current playhead position in project seconds. */
  get positionSec() {
    if (!this.playing || !this.ctx) return this._playStartSec;
    return this._playStartSec + (this.ctx.currentTime - this._playStartCtx);
  }

  setMasterGainDb(db) {
    if (this.masterGain) this.masterGain.gain.value = dbToGain(clamp(db, -60, 12));
  }

  /** One-shot audition of a buffer, used by the SFX panel preview. */
  auditionBuffer(buffer, { gainDb = 0 } = {}) {
    if (!this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = dbToGain(gainDb);
    src.connect(g);
    g.connect(this.masterGain);
    src.start();
    return src;
  }
}

export const engine = new Engine();
export { uid };
