import tonejs from "@tonejs/midi";
import type { Project, Track } from "../shared/types";
import { GM_PROGRAMS, TRACK_COLORS } from "../shared/music";
import { newId } from "./store";

const { Midi } = tonejs;

export const DEFAULT_PPQ = 480;

export function emptyProject(name: string, opts: { bpm?: number; numerator?: number; denominator?: number; ppq?: number } = {}): Project {
  const now = new Date().toISOString();
  return {
    id: newId("p_"),
    name,
    ppq: opts.ppq ?? DEFAULT_PPQ,
    tempos: [{ tick: 0, bpm: opts.bpm ?? 120 }],
    timeSignatures: [{ tick: 0, numerator: opts.numerator ?? 4, denominator: opts.denominator ?? 4 }],
    tracks: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function newTrack(project: Project, opts: Partial<Omit<Track, "id" | "notes">> = {}): Track {
  const program = opts.program ?? 0;
  const channel = opts.channel ?? nextFreeChannel(project);
  return {
    id: newId("t_"),
    name: opts.name ?? (channel === 9 ? "Drums" : GM_PROGRAMS[program]),
    channel,
    program,
    color: opts.color ?? TRACK_COLORS[project.tracks.length % TRACK_COLORS.length],
    muted: opts.muted ?? false,
    solo: opts.solo ?? false,
    notes: [],
  };
}

function nextFreeChannel(project: Project): number {
  const used = new Set(project.tracks.map((t) => t.channel));
  for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
  return 0;
}

/** Parses a Standard MIDI File into a project. */
export function midiToProject(bytes: Uint8Array, name: string): Project {
  const midi = new Midi(bytes);
  const project = emptyProject(name, { ppq: midi.header.ppq });
  project.tempos = midi.header.tempos.map((t) => ({ tick: t.ticks, bpm: Math.round(t.bpm * 1000) / 1000 }));
  if (project.tempos.length === 0) project.tempos = [{ tick: 0, bpm: 120 }];
  project.timeSignatures = midi.header.timeSignatures.map((t) => ({
    tick: t.ticks,
    numerator: t.timeSignature[0],
    denominator: t.timeSignature[1],
  }));
  if (project.timeSignatures.length === 0) project.timeSignatures = [{ tick: 0, numerator: 4, denominator: 4 }];
  const ks = midi.header.keySignatures[0];
  if (ks) project.keySignature = `${ks.key} ${ks.scale}`;
  if (midi.header.name) project.name = name || midi.header.name;

  for (const mt of midi.tracks) {
    if (mt.notes.length === 0) continue;
    const isDrum = mt.channel === 9 || mt.instrument.percussion;
    const track = newTrack(project, {
      name: mt.name || (isDrum ? "Drums" : GM_PROGRAMS[mt.instrument.number]),
      channel: mt.channel,
      program: mt.instrument.number,
    });
    track.notes = mt.notes.map((n) => ({
      id: newId("n_"),
      pitch: n.midi,
      tick: n.ticks,
      duration: Math.max(1, n.durationTicks),
      velocity: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
    }));
    track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    project.tracks.push(track);
  }
  return project;
}

/** Serializes a project to a Standard MIDI File. */
export function projectToMidi(project: Project): Uint8Array {
  const midi = new Midi();
  // header.ppq is a getter; fromJSON is the supported way to set it.
  midi.header.fromJSON({ ...midi.header.toJSON(), ppq: project.ppq });
  midi.header.name = project.name;
  for (const t of project.tempos) midi.header.tempos.push({ ticks: t.tick, bpm: t.bpm });
  for (const ts of project.timeSignatures) midi.header.timeSignatures.push({ ticks: ts.tick, timeSignature: [ts.numerator, ts.denominator] });
  if (project.keySignature) {
    const [key, scale] = project.keySignature.split(" ");
    midi.header.keySignatures.push({ ticks: 0, key, scale: scale === "minor" ? "minor" : "major" });
  }
  midi.header.update();

  for (const t of project.tracks) {
    const mt = midi.addTrack();
    mt.name = t.name;
    mt.channel = t.channel;
    mt.instrument.number = t.program;
    for (const n of t.notes) {
      mt.addNote({ midi: n.pitch, ticks: n.tick, durationTicks: n.duration, velocity: n.velocity / 127 });
    }
  }
  return midi.toArray();
}
