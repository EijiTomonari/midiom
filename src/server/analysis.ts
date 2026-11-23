import type { Note, Project, Track } from "../shared/types";
import { NOTE_NAMES, barLines, pitchName, projectEndTick, tickToBarBeat } from "../shared/music";

// ---- Key detection (Krumhansl–Schmuckler) ---------------------------------

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function pitchClassHistogram(notes: Note[]): number[] {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.pitch % 12] += n.duration;
  return h;
}

export function detectKey(notes: Note[]): { key: string; confidence: number }[] {
  if (notes.length === 0) return [];
  const hist = pitchClassHistogram(notes);
  const results: { key: string; confidence: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
    results.push({ key: `${NOTE_NAMES[tonic]} major`, confidence: correlation(rotated, MAJOR_PROFILE) });
    results.push({ key: `${NOTE_NAMES[tonic]} minor`, confidence: correlation(rotated, MINOR_PROFILE) });
  }
  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((r) => ({ key: r.key, confidence: Math.round(r.confidence * 100) / 100 }));
}

// ---- Chord recognition ---------------------------------------------------------

const CHORD_TEMPLATES: { suffix: string; intervals: number[] }[] = [
  { suffix: "", intervals: [0, 4, 7] },
  { suffix: "m", intervals: [0, 3, 7] },
  { suffix: "dim", intervals: [0, 3, 6] },
  { suffix: "aug", intervals: [0, 4, 8] },
  { suffix: "sus2", intervals: [0, 2, 7] },
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "7", intervals: [0, 4, 7, 10] },
  { suffix: "maj7", intervals: [0, 4, 7, 11] },
  { suffix: "m7", intervals: [0, 3, 7, 10] },
  { suffix: "m7b5", intervals: [0, 3, 6, 10] },
  { suffix: "dim7", intervals: [0, 3, 6, 9] },
  { suffix: "6", intervals: [0, 4, 7, 9] },
  { suffix: "m6", intervals: [0, 3, 7, 9] },
  { suffix: "add9", intervals: [0, 2, 4, 7] },
  { suffix: "5", intervals: [0, 7] },
];

/** Names the chord sounding in a set of notes (weighted by how long each sounds within the window). */
export function identifyChord(notes: Note[], startTick: number, endTick: number): { name: string; notes: string[] } | null {
  const weights = new Array(12).fill(0);
  let bass: number | null = null;
  for (const n of notes) {
    const overlap = Math.min(n.tick + n.duration, endTick) - Math.max(n.tick, startTick);
    if (overlap <= 0) continue;
    weights[n.pitch % 12] += overlap;
    if (bass === null || n.pitch < bass) bass = n.pitch;
  }
  const total = weights.reduce((s, x) => s + x, 0);
  if (total === 0 || bass === null) return null;
  const present = weights.map((w) => w / total);
  const pcs = present.map((w, i) => (w > 0.04 ? i : -1)).filter((i) => i >= 0);
  if (pcs.length === 1) return { name: NOTE_NAMES[pcs[0]], notes: [NOTE_NAMES[pcs[0]]] };

  let best: { score: number; root: number; suffix: string } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const tpl of CHORD_TEMPLATES) {
      const tplPcs = tpl.intervals.map((i) => (root + i) % 12);
      let score = 0;
      for (let pc = 0; pc < 12; pc++) score += tplPcs.includes(pc) ? present[pc] : -present[pc] * 0.8;
      // Penalize template tones that are missing; favor simpler chords and the bass as root.
      score -= tplPcs.filter((pc) => present[pc] === 0).length * 0.25;
      score -= tpl.intervals.length * 0.01;
      if (root === bass % 12) score += 0.05;
      if (!best || score > best.score) best = { score, root, suffix: tpl.suffix };
    }
  }
  if (!best) return null;
  let name = NOTE_NAMES[best.root] + best.suffix;
  if (bass % 12 !== best.root) name += `/${NOTE_NAMES[bass % 12]}`;
  return { name, notes: pcs.map((pc) => NOTE_NAMES[pc]) };
}

function harmonicNotes(project: Project, trackIds?: string[]): Note[] {
  return project.tracks
    .filter((t) => t.channel !== 9 && (!trackIds || trackIds.includes(t.id)))
    .flatMap((t) => t.notes);
}

export function chordProgression(
  project: Project,
  opts: { resolution: "bar" | "half-bar" | "beat"; startTick?: number; endTick?: number; trackIds?: string[] },
) {
  const notes = harmonicNotes(project, opts.trackIds);
  const end = opts.endTick ?? projectEndTick(project);
  const start = opts.startTick ?? 0;
  const out: { bar: number; beat: number; chord: string; pitchClasses: string[] }[] = [];
  for (const b of barLines(project, end)) {
    const barEnd = b.tick + b.beatTicks * b.numerator;
    if (barEnd <= start) continue;
    const step = opts.resolution === "bar" ? b.beatTicks * b.numerator : opts.resolution === "beat" ? b.beatTicks : (b.beatTicks * b.numerator) / 2;
    for (let t = b.tick; t < barEnd - 1; t += step) {
      const chord = identifyChord(notes, t, t + step);
      const pos = tickToBarBeat(project, t);
      out.push({ bar: pos.bar, beat: pos.beat, chord: chord?.name ?? "—", pitchClasses: chord?.notes ?? [] });
    }
  }
  // Collapse consecutive repeats for readability.
  return out.filter((c, i) => i === 0 || c.chord !== out[i - 1].chord);
}

// ---- Statistics ---------------------------------------------------------------

export function trackStats(project: Project, track: Track) {
  const notes = track.notes;
  if (notes.length === 0) return { noteCount: 0 };
  let lo = 127, hi = 0, vel = 0, maxPoly = 0;
  const events: [number, number][] = [];
  const durations = new Map<number, number>();
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
    vel += n.velocity;
    events.push([n.tick, 1], [n.tick + n.duration, -1]);
    const beats = Math.round((n.duration / project.ppq) * 8) / 8;
    durations.set(beats, (durations.get(beats) ?? 0) + 1);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  for (const [, d] of events) maxPoly = Math.max(maxPoly, (cur += d));
  const first = Math.min(...notes.map((n) => n.tick));
  const last = Math.max(...notes.map((n) => n.tick + n.duration));
  return {
    noteCount: notes.length,
    range: { low: pitchName(lo), high: pitchName(hi), lowMidi: lo, highMidi: hi },
    averageVelocity: Math.round(vel / notes.length),
    maxPolyphony: maxPoly,
    role: maxPoly >= 3 ? "chordal" : hi < 55 ? "bass" : "melodic",
    spans: { from: tickToBarBeat(project, first), to: tickToBarBeat(project, last) },
    commonDurationsInBeats: [...durations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([beats, count]) => ({ beats, count })),
  };
}

// ---- ASCII piano roll -----------------------------------------------------------

/**
 * Renders notes as a text grid so an agent can "see" the music.
 * Rows are pitches (high at top), columns are time steps.
 * `#` = note onset, `=` = sustain, `|` = bar line, `.` = empty, `:` = beat.
 */
export function renderPianoRoll(
  project: Project,
  opts: { startTick: number; endTick: number; stepTicks: number; trackIds?: string[] },
): string {
  const notes = project.tracks.filter((t) => !opts.trackIds || opts.trackIds.includes(t.id)).flatMap((t) => t.notes);
  const visible = notes.filter((n) => n.tick < opts.endTick && n.tick + n.duration > opts.startTick);
  if (visible.length === 0) return "(no notes in this range)";
  const lo = Math.min(...visible.map((n) => n.pitch));
  const hi = Math.max(...visible.map((n) => n.pitch));
  const cols = Math.ceil((opts.endTick - opts.startTick) / opts.stepTicks);
  const bars = barLines(project, opts.endTick);
  const barCols = new Set(bars.filter((b) => b.tick >= opts.startTick).map((b) => Math.round((b.tick - opts.startTick) / opts.stepTicks)));
  const beatCols = new Set<number>();
  for (const b of bars) for (let i = 1; i < b.numerator; i++) beatCols.add(Math.round((b.tick + i * b.beatTicks - opts.startTick) / opts.stepTicks));

  const grid: string[][] = [];
  for (let p = hi; p >= lo; p--) grid.push(Array.from({ length: cols }, (_, c) => (barCols.has(c) ? "|" : beatCols.has(c) ? ":" : ".")));
  for (const n of visible) {
    const row = hi - n.pitch;
    const c0 = Math.floor((n.tick - opts.startTick) / opts.stepTicks);
    const c1 = Math.ceil((n.tick + n.duration - opts.startTick) / opts.stepTicks);
    for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
      if (c === c0) grid[row][c] = "#";
      else if (grid[row][c] !== "#") grid[row][c] = "=";
    }
  }
  const header = "     " + Array.from({ length: cols }, (_, c) => {
    const b = bars.find((x) => Math.round((x.tick - opts.startTick) / opts.stepTicks) === c);
    return b ? String(b.bar % 10) : " ";
  }).join("");
  const lines = grid.map((row, i) => pitchName(hi - i).padEnd(4) + " " + row.join(""));
  return [header + "   (bar numbers mod 10)", ...lines].join("\n");
}
