// Sampled grand piano (Salamander Grand Piano V3, CC BY 3.0 — see
// public/samples/piano/LICENSE.md). Three velocity layers sampled every minor
// third from A0 to C8; notes in between are pitch-shifted from the nearest
// sample, at most a semitone, which is inaudible on a piano.

const BASE = "samples/piano";
const SAMPLED = Array.from({ length: 30 }, (_, i) => 21 + i * 3); // 21, 24, … 108

/** Layers in load order: medium first so playback can start sooner. */
const LAYERS = [
  { name: "mf", velocity: 80 },
  { name: "p", velocity: 40 },
  { name: "f", velocity: 115 },
] as const;
type LayerName = (typeof LAYERS)[number]["name"];

/** Real pianos have no dampers above roughly F#6: those strings ring on after the key is released. */
const UNDAMPED_FROM = 90;

export interface PianoVoice {
  stop(at: number): void;
}

export class Piano {
  private layers = new Map<LayerName, Map<number, AudioBuffer>>();
  private releases = new Map<number, AudioBuffer>();
  progress = 0;
  onProgress: ((fraction: number) => void) | null = null;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
  ) {}

  /** True once at least one velocity layer is fully loaded. */
  get ready() {
    return this.layers.size > 0;
  }

  async load() {
    const total = LAYERS.length * SAMPLED.length + 88;
    let done = 0;
    const tick = () => {
      this.progress = ++done / total;
      this.onProgress?.(this.progress);
    };
    const fetchBuffer = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    for (const layer of LAYERS) {
      const buffers = new Map<number, AudioBuffer>();
      await Promise.all(
        SAMPLED.map(async (midi) => {
          buffers.set(midi, await fetchBuffer(`${BASE}/${layer.name}/${midi}.mp3`));
          tick();
        }),
      );
      this.layers.set(layer.name, buffers);
    }
    await Promise.all(
      Array.from({ length: 88 }, async (_, i) => {
        try {
          this.releases.set(21 + i, await fetchBuffer(`${BASE}/release/${21 + i}.mp3`));
        } catch {
          // Release noises are a nicety; play on without them.
        }
        tick();
      }),
    );
  }

  /** Picks the loaded layer recorded closest to this velocity. */
  private layerFor(velocity: number) {
    const wanted = velocity < 56 ? "p" : velocity < 96 ? "mf" : "f";
    const order: LayerName[] = wanted === "p" ? ["p", "mf", "f"] : wanted === "f" ? ["f", "mf", "p"] : ["mf", "p", "f"];
    for (const name of order) {
      const buffers = this.layers.get(name);
      if (buffers) return { buffers, nominal: LAYERS.find((l) => l.name === name)!.velocity };
    }
    return null;
  }

  play(pitch: number, velocity: number, when: number, duration: number): PianoVoice | null {
    const layer = this.layerFor(velocity);
    if (!layer) return null;
    const { ctx } = this;
    const nearest = Math.min(108, Math.max(21, 21 + Math.round((pitch - 21) / 3) * 3));
    const buffer = layer.buffers.get(nearest);
    if (!buffer) return null;

    const t0 = Math.max(when, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 2 ** ((pitch - nearest) / 12);
    const gain = ctx.createGain();
    // Layers carry the timbre; fine-tune loudness within the layer.
    const level = Math.min(1.6, Math.max(0.15, (velocity / layer.nominal) ** 1.3)) * 0.9;
    gain.gain.setValueAtTime(level, t0);
    src.connect(gain);
    gain.connect(this.out);
    src.start(t0);

    // Schedule the key release (the damper falls) at the end of the note.
    const end = t0 + duration;
    const tc = pitch >= UNDAMPED_FROM ? 0.6 : pitch < 40 ? 0.12 : 0.08;
    gain.gain.setValueAtTime(level, end);
    gain.gain.setTargetAtTime(0, end, tc);
    src.stop(Math.min(end + tc * 8, t0 + buffer.duration / src.playbackRate.value + 0.05));
    const thump = this.release(pitch, velocity, end);

    return {
      // Silence immediately (pause/stop), including a release noise not yet played.
      stop: (at: number) => {
        const now = Math.max(at, ctx.currentTime);
        if (now >= end + tc * 8) return;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.03);
        try {
          src.stop(now + 0.2);
          if (thump && now < end) thump.stop(now);
        } catch {
          // already stopped
        }
      },
    };
  }

  /** The soft thump of the key and damper returning. */
  private release(pitch: number, velocity: number, at: number): AudioBufferSourceNode | null {
    const buf = this.releases.get(pitch);
    if (!buf || pitch >= UNDAMPED_FROM) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.04 + (0.06 * velocity) / 127;
    src.connect(g);
    g.connect(this.out);
    src.start(at);
    return src;
  }
}
