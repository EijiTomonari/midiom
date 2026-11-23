import type { Appearance, Project, TempoEvent, TimeSignatureEvent } from "./types";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const LETTER_OFFSETS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 60 -> "C4" */
export function pitchName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** Parses a MIDI number or a note name like "C4", "F#3", "Bb2", "c-1". */
export function parsePitch(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0 || input > 127) throw new Error(`Pitch out of range: ${input}`);
    return input;
  }
  const s = input.trim();
  if (/^\d+$/.test(s)) return parsePitch(Number(s));
  const m = /^([A-Ga-g])([#b♯♭]*)(-?\d+)$/.exec(s);
  if (!m) throw new Error(`Invalid pitch: "${input}" (use a MIDI number or a name like C4, F#3, Bb2)`);
  let pc = LETTER_OFFSETS[m[1].toUpperCase()];
  for (const acc of m[2]) pc += acc === "#" || acc === "♯" ? 1 : -1;
  const pitch = (Number(m[3]) + 1) * 12 + pc;
  return parsePitch(pitch);
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

// ---- Time conversion ----------------------------------------------------

export function sortedTempos(project: Pick<Project, "tempos">): TempoEvent[] {
  const t = [...project.tempos].sort((a, b) => a.tick - b.tick);
  if (t.length === 0 || t[0].tick > 0) t.unshift({ tick: 0, bpm: t[0]?.bpm ?? 120 });
  return t;
}

export function ticksToSeconds(project: Pick<Project, "tempos" | "ppq">, tick: number): number {
  const tempos = sortedTempos(project);
  let seconds = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
    if (tick <= start) break;
    const span = Math.min(tick, end) - start;
    seconds += (span / project.ppq) * (60 / tempos[i].bpm);
  }
  return seconds;
}

export function secondsToTicks(project: Pick<Project, "tempos" | "ppq">, seconds: number): number {
  const tempos = sortedTempos(project);
  let elapsed = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].tick;
    const end = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
    const secPerTick = 60 / tempos[i].bpm / project.ppq;
    const segSeconds = (end - start) * secPerTick;
    if (seconds <= elapsed + segSeconds) return start + (seconds - elapsed) / secPerTick;
    elapsed += segSeconds;
  }
  return 0;
}

function sortedTimeSigs(project: Pick<Project, "timeSignatures">): TimeSignatureEvent[] {
  const ts = [...project.timeSignatures].sort((a, b) => a.tick - b.tick);
  if (ts.length === 0 || ts[0].tick > 0) ts.unshift({ tick: 0, numerator: 4, denominator: 4 });
  return ts;
}

/** Converts a tick to a 1-based bar and beat position, e.g. { bar: 3, beat: 2.5 }. */
export function tickToBarBeat(project: Pick<Project, "timeSignatures" | "ppq">, tick: number): { bar: number; beat: number } {
  const sigs = sortedTimeSigs(project);
  let bar = 1;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    const beatTicks = (project.ppq * 4) / s.denominator;
    const barTicks = beatTicks * s.numerator;
    const end = i + 1 < sigs.length ? sigs[i + 1].tick : Infinity;
    if (tick < end) {
      const into = tick - s.tick;
      const bars = Math.floor(into / barTicks);
      const beat = (into - bars * barTicks) / beatTicks + 1;
      return { bar: bar + bars, beat: Math.round(beat * 1000) / 1000 };
    }
    bar += Math.ceil((end - s.tick) / barTicks);
  }
  return { bar: 1, beat: 1 };
}

/** Converts a 1-based bar (and optional 1-based beat) to ticks. */
export function barBeatToTick(project: Pick<Project, "timeSignatures" | "ppq">, bar: number, beat = 1): number {
  const sigs = sortedTimeSigs(project);
  let barCursor = 1;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    const beatTicks = (project.ppq * 4) / s.denominator;
    const barTicks = beatTicks * s.numerator;
    const end = i + 1 < sigs.length ? sigs[i + 1].tick : Infinity;
    const barsInSeg = end === Infinity ? Infinity : Math.ceil((end - s.tick) / barTicks);
    if (bar < barCursor + barsInSeg) {
      return Math.round(s.tick + (bar - barCursor) * barTicks + (beat - 1) * beatTicks);
    }
    barCursor += barsInSeg;
  }
  return 0;
}

/** Bar line positions (in ticks) up to endTick, with their bar numbers. */
export function barLines(project: Pick<Project, "timeSignatures" | "ppq">, endTick: number): { tick: number; bar: number; beatTicks: number; numerator: number }[] {
  const sigs = sortedTimeSigs(project);
  const out: { tick: number; bar: number; beatTicks: number; numerator: number }[] = [];
  let bar = 1;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    const beatTicks = (project.ppq * 4) / s.denominator;
    const barTicks = beatTicks * s.numerator;
    const end = Math.min(i + 1 < sigs.length ? sigs[i + 1].tick : Infinity, endTick);
    for (let t = s.tick; t < end; t += barTicks) out.push({ tick: t, bar: bar++, beatTicks, numerator: s.numerator });
  }
  return out;
}

export function projectEndTick(project: Project): number {
  let end = 0;
  for (const tr of project.tracks) for (const n of tr.notes) end = Math.max(end, n.tick + n.duration);
  return end;
}

// ---- General MIDI ---------------------------------------------------------

export const GM_PROGRAMS = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)", "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot",
];

export const TRACK_COLORS = ["#4ade80", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171"];

/** Synthesia-style hand colors. */
export const HAND_COLORS = { left: "#60a5fa", right: "#4ade80", none: "#6b7280" } as const;

// ---- Appearance ------------------------------------------------------------------

export const DEFAULT_APPEARANCE: Appearance = {
  colorBy: "track",
  handColors: { ...HAND_COLORS },
  noteStyle: "solid",
  glow: 0.35,
  particles: 0.5,
  litKeys: true,
  keyEdgeColor: "#60a5fa",
  keyEdgeFollowsNotes: true,
  noteLabels: false,
  background: "#0e0f13",
};

export const APPEARANCE_PRESETS: Record<string, { label: string; appearance: Partial<Appearance> }> = {
  classic: { label: "Classic", appearance: DEFAULT_APPEARANCE },
  "neon-blue": {
    label: "Neon blue",
    appearance: { colorBy: "hand", handColors: { left: "#3b5bff", right: "#4d7cff", none: "#3b5bff" }, noteStyle: "neon", glow: 0.9, particles: 0.9, litKeys: true, keyEdgeColor: "#3b5bff", keyEdgeFollowsNotes: true, noteLabels: false, background: "#05060c" },
  },
  aurora: {
    label: "Aurora",
    appearance: { colorBy: "hand", handColors: { left: "#2dd4bf", right: "#5eead4", none: "#2dd4bf" }, noteStyle: "neon", glow: 0.8, particles: 0.8, litKeys: true, keyEdgeColor: "#2dd4bf", keyEdgeFollowsNotes: true, noteLabels: false, background: "#040a09" },
  },
  synthwave: {
    label: "Synthwave",
    appearance: { colorBy: "hand", handColors: { left: "#e879f9", right: "#3b82f6", none: "#94a3b8" }, noteStyle: "glass", glow: 0.7, particles: 0.6, litKeys: true, keyEdgeColor: "#60a5fa", keyEdgeFollowsNotes: true, noteLabels: true, background: "#07060f" },
  },
};

export function resolveAppearance(p: Pick<Project, "appearance">): Appearance {
  const a = p.appearance ?? {};
  return { ...DEFAULT_APPEARANCE, ...a, handColors: { ...DEFAULT_APPEARANCE.handColors, ...a.handColors } };
}
