// A tiny General-MIDI-ish synth on raw WebAudio. No samples to download:
// each GM family maps to a waveform + envelope that sounds roughly right.

interface Patch {
  type: OscillatorType;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  cutoff: number;
  detune?: number;
  gain: number;
}

function patchFor(program: number): Patch {
  const family = Math.floor(program / 8);
  switch (family) {
    case 0: // piano
      return { type: "triangle", attack: 0.004, decay: 1.2, sustain: 0.15, release: 0.25, cutoff: 5000, gain: 0.5 };
    case 1: // chromatic percussion
      return { type: "sine", attack: 0.002, decay: 0.8, sustain: 0.0, release: 0.4, cutoff: 8000, gain: 0.5 };
    case 2: // organ
      return { type: "square", attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.08, cutoff: 2500, gain: 0.22 };
    case 3: // guitar
      return { type: "sawtooth", attack: 0.003, decay: 0.6, sustain: 0.2, release: 0.2, cutoff: 2200, gain: 0.3 };
    case 4: // bass
      return { type: "sawtooth", attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.1, cutoff: 900, gain: 0.45 };
    case 5: case 6: // strings, ensemble
      return { type: "sawtooth", attack: 0.12, decay: 0.3, sustain: 0.8, release: 0.4, cutoff: 2600, detune: 8, gain: 0.18 };
    case 7: case 8: // brass, reed
      return { type: "sawtooth", attack: 0.04, decay: 0.2, sustain: 0.75, release: 0.15, cutoff: 3000, gain: 0.22 };
    case 9: // pipe
      return { type: "sine", attack: 0.05, decay: 0.1, sustain: 0.85, release: 0.15, cutoff: 6000, gain: 0.4 };
    case 10: // synth lead
      return { type: "square", attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.1, cutoff: 4000, gain: 0.2 };
    case 11: // pads
      return { type: "sawtooth", attack: 0.4, decay: 0.5, sustain: 0.8, release: 0.8, cutoff: 1800, detune: 12, gain: 0.15 };
    default:
      return { type: "triangle", attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.2, cutoff: 4000, gain: 0.35 };
  }
}

import { Piano } from "./piano";

/** GM programs that use the sampled grand: acoustic, bright, electric grand, honky-tonk. */
const SAMPLED_PIANO_PROGRAMS = new Set([0, 1, 2, 3]);
const MAX_VOICES = 160;

/**
 * A synthetic concert-hall impulse response: decaying stereo noise with
 * early reflections, darker as it fades. No file to download.
 */
function hallImpulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(seconds * rate);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // One-pole low-pass whose cutoff falls over time: highs die first, as in a real room.
      const k = 0.55 - 0.45 * Math.min(1, t / seconds);
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 3.2) * (t < 0.012 ? t / 0.012 : 1);
    }
    for (const [at, g] of [[0.013, 0.5], [0.021, 0.35], [0.034, 0.28], [0.047, 0.2]] as const) {
      d[Math.floor((at + ch * 0.003) * rate)] += g;
    }
  }
  return ir;
}

const midiToFreq = (p: number) => 440 * 2 ** ((p - 69) / 12);

export class Synth {
  ctx: AudioContext;
  private master: GainNode;
  private noise: AudioBuffer;
  private voices: { stop: (t: number) => void; end: number }[] = [];
  piano: Piano;

  constructor() {
    this.ctx = new AudioContext();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(comp);
    // Room: a parallel reverb send.
    const reverb = this.ctx.createConvolver();
    reverb.buffer = hallImpulse(this.ctx);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.22;
    this.master.connect(wet);
    wet.connect(reverb);
    reverb.connect(comp);
    this.piano = new Piano(this.ctx, this.master);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() {
    if (this.ctx.state !== "running") return this.ctx.resume();
  }

  private track(voice: { stop: (t: number) => void }, end: number) {
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.voices.length >= MAX_VOICES) this.voices.shift()!.stop(now);
    this.voices.push({ stop: voice.stop, end });
  }

  /** Schedules a note. `when` and `duration` are in AudioContext seconds. */
  play(opts: { pitch: number; velocity: number; when: number; duration: number; program: number; drums: boolean }) {
    if (opts.drums) return this.drum(opts.pitch, opts.velocity, opts.when);
    if (SAMPLED_PIANO_PROGRAMS.has(opts.program) && this.piano.ready) {
      const v = this.piano.play(opts.pitch, opts.velocity, opts.when, opts.duration);
      if (v) {
        this.track(v, opts.when + opts.duration + 5);
        return v;
      }
    }
    const p = patchFor(opts.program);
    const { ctx } = this;
    const t0 = Math.max(opts.when, ctx.currentTime);
    const peak = p.gain * (opts.velocity / 127) ** 1.5;
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = p.cutoff * (0.6 + (0.6 * opts.velocity) / 127);
    // Spread instruments across the stereo field by pitch, like sitting at a keyboard.
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-0.6, Math.min(0.6, (opts.pitch - 64) / 60));
    filter.connect(env);
    env.connect(pan);
    pan.connect(this.master);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + p.attack);
    env.gain.setTargetAtTime(peak * p.sustain, t0 + p.attack, p.decay / 3);

    const oscs = [ctx.createOscillator()];
    if (p.detune) oscs.push(ctx.createOscillator());
    oscs.forEach((o, i) => {
      o.type = p.type;
      o.frequency.value = midiToFreq(opts.pitch);
      if (p.detune) o.detune.value = i === 0 ? -p.detune : p.detune;
      o.connect(filter);
      o.start(t0);
    });

    // Release at the end of the note…
    const end = t0 + opts.duration;
    env.gain.setTargetAtTime(0, end, p.release / 3);
    oscs.forEach((o) => o.stop(end + p.release * 2));
    // …or right away if playback stops first.
    const voice = {
      stop: (t: number) => {
        const at = Math.max(t, ctx.currentTime);
        if (at >= end + p.release * 2) return;
        env.gain.cancelScheduledValues(at);
        env.gain.setTargetAtTime(0, at, 0.02);
        oscs.forEach((o) => {
          try {
            o.stop(at + 0.1);
          } catch {
            // older browsers refuse a second stop()
          }
        });
      },
    };
    this.track(voice, end + p.release * 2);
    return voice;
  }

  private drum(pitch: number, velocity: number, when: number) {
    const { ctx } = this;
    const t = Math.max(when, ctx.currentTime);
    const v = (velocity / 127) * 0.9;
    const out = ctx.createGain();
    out.connect(this.master);
    if (pitch === 35 || pitch === 36) {
      // kick
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      out.gain.setValueAtTime(v, t);
      out.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(out);
      o.start(t);
      o.stop(t + 0.4);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    const isHat = [42, 44, 46, 49, 51, 52, 53, 55, 57, 59].includes(pitch);
    const isSnare = [37, 38, 39, 40].includes(pitch);
    f.type = isHat ? "highpass" : "bandpass";
    f.frequency.value = isHat ? 7000 : isSnare ? 1800 : 400 + (pitch - 41) * 40;
    const len = pitch === 46 || pitch === 49 || pitch === 57 ? 0.5 : isHat ? 0.06 : isSnare ? 0.18 : 0.25;
    out.gain.setValueAtTime(v * (isHat ? 0.4 : 0.8), t);
    out.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f);
    f.connect(out);
    src.start(t);
    src.stop(t + len + 0.05);
    if (!isHat && !isSnare) {
      // toms: add a pitched body
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(80 + (pitch - 41) * 15, t);
      o.frequency.exponentialRampToValueAtTime(50 + (pitch - 41) * 10, t + len);
      o.connect(out);
      o.start(t);
      o.stop(t + len);
    }
  }

  stopAll() {
    for (const v of this.voices) v.stop(this.ctx.currentTime);
    this.voices = [];
  }
}
