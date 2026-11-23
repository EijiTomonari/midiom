import type { Project } from "../../shared/types";
import { pedalReleaseTick, projectEndTick, secondsToTicks, ticksToSeconds } from "../../shared/music";
import { Synth } from "./synth";

interface Scheduled {
  start: number; // seconds from song start
  duration: number;
  pitch: number;
  velocity: number;
  program: number;
  drums: boolean;
}

const LOOKAHEAD = 0.15;

/** Plays a project through the synth with a look-ahead scheduler. */
export class Player {
  private synth: Synth | null = null;
  private project: Project | null = null;
  private events: Scheduled[] = [];
  private endSeconds = 0;
  private timer: number | null = null;
  private startAudioTime = 0;
  private startSeconds = 0;
  private scheduledUntil = 0;
  playing = false;
  private pausedTick = 0;
  onEnd: (() => void) | null = null;

  onLoadProgress: ((fraction: number) => void) | null = null;

  /** Creates the audio engine and starts loading piano samples in the background. */
  init() {
    if (this.synth) return this.synth;
    this.synth = new Synth();
    this.synth.piano.onProgress = (f) => this.onLoadProgress?.(f);
    this.synth.piano.load().catch((e) => console.warn("[midiom] piano samples failed to load; using the synth", e));
    return this.synth;
  }

  get loadProgress() {
    return this.synth?.piano.progress ?? 0;
  }

  private ensureSynth() {
    const synth = this.init();
    synth.resume();
    return synth;
  }

  setProject(p: Project | null) {
    const changed = p?.id !== this.project?.id;
    this.project = p;
    this.events = [];
    if (!p) return;
    const anySolo = p.tracks.some((t) => t.solo);
    for (const t of p.tracks) {
      if (t.muted || (anySolo && !t.solo)) continue;
      // The next time each pitch is struck again: re-striking a key stops its old sound.
      const nextStrike = new Map<string, number>();
      const byPitch = new Map<number, number[]>();
      for (const n of t.notes) (byPitch.get(n.pitch) ?? byPitch.set(n.pitch, []).get(n.pitch)!).push(n.tick);
      for (const ticks of byPitch.values()) ticks.sort((a, b) => a - b);
      for (const n of t.notes) {
        const ticks = byPitch.get(n.pitch)!;
        const next = ticks.find((x) => x > n.tick);
        if (next !== undefined) nextStrike.set(n.id, next);
      }
      for (const n of t.notes) {
        const start = ticksToSeconds(p, n.tick);
        // With the sustain pedal down, the string rings on after the key is released.
        let off = pedalReleaseTick(t.pedal, n.tick + n.duration);
        const restrike = nextStrike.get(n.id);
        if (restrike !== undefined && restrike < off) off = Math.max(n.tick + n.duration, restrike);
        this.events.push({ start, duration: ticksToSeconds(p, off) - start, pitch: n.pitch, velocity: n.velocity, program: t.program, drums: t.channel === 9 });
      }
    }
    this.events.sort((a, b) => a.start - b.start);
    this.endSeconds = this.events.reduce((m, e) => Math.max(m, e.start + e.duration), ticksToSeconds(p, projectEndTick(p)));
    if (changed) {
      this.stop();
      this.pausedTick = 0;
    }
  }

  /** Current position in ticks. */
  get tick(): number {
    if (!this.project) return 0;
    if (!this.playing || !this.synth) return this.pausedTick;
    return secondsToTicks(this.project, this.startSeconds + (this.synth.ctx.currentTime - this.startAudioTime));
  }

  play(fromTick?: number) {
    if (!this.project) return;
    const synth = this.ensureSynth();
    if (this.playing) this.pause();
    const tick = fromTick ?? this.pausedTick;
    this.startSeconds = ticksToSeconds(this.project, tick);
    this.startAudioTime = synth.ctx.currentTime + 0.05;
    this.scheduledUntil = this.startSeconds;
    // Notes already sounding at the start position.
    for (const e of this.events) {
      if (e.start < this.startSeconds && e.start + e.duration > this.startSeconds + 0.05) {
        synth.play({ ...e, when: this.startAudioTime, duration: e.start + e.duration - this.startSeconds });
      }
    }
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private schedule() {
    if (!this.project || !this.synth) return;
    const now = this.startSeconds + (this.synth.ctx.currentTime - this.startAudioTime);
    const until = now + LOOKAHEAD;
    for (const e of this.events) {
      if (e.start < this.scheduledUntil) continue;
      if (e.start >= until) break;
      this.synth.play({ ...e, when: this.startAudioTime + (e.start - this.startSeconds) });
    }
    this.scheduledUntil = until;
    // Let the last notes (and their pedal and reverb tail) ring out.
    if (now > this.endSeconds + 1.5) {
      this.pause();
      this.pausedTick = 0;
      this.onEnd?.();
    }
  }

  /** Re-schedule after the project changed during playback. */
  refresh() {
    if (this.playing) this.play(this.tick);
  }

  pause() {
    if (!this.playing) return;
    this.pausedTick = this.tick;
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.synth?.stopAll();
  }

  stop() {
    this.pause();
    this.pausedTick = 0;
  }

  seek(tick: number) {
    if (this.playing) this.play(tick);
    else this.pausedTick = Math.max(0, tick);
  }

  preview(pitch: number, program: number, drums = false, velocity = 90) {
    const synth = this.ensureSynth();
    synth.play({ pitch, velocity, program, drums, when: synth.ctx.currentTime, duration: 0.35 });
  }
}

export const player = new Player();
