import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { Hand, Note, Project, Track } from "../shared/types";
import { GM_PROGRAMS, barBeatToTick, parsePitch, pitchName, projectEndTick, ticksToSeconds, tickToBarBeat } from "../shared/music";
import { ProjectStore, newId } from "./store";
import { emptyProject, midiToProject, newTrack, projectToMidi } from "./midi-io";
import { assignHands, chordProgression, detectKey, renderPianoRoll, trackStats } from "./analysis";

/**
 * Every operation on a project is a command. The MCP server exposes these as
 * tools, and the web UI calls the same commands over its WebSocket, so the
 * human and the agent always edit through one code path.
 */
export interface Command<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  /** Commands hidden from MCP (UI-only helpers). */
  uiOnly?: boolean;
  run(ctx: CommandContext, args: z.infer<z.ZodObject<S>>): CommandResult | Promise<CommandResult>;
}

export interface CommandResult {
  /** JSON-serializable result returned to the caller. */
  data: unknown;
  /** One-line human summary for the activity feed. Omit for quiet reads. */
  summary?: string;
}

export interface CommandContext {
  store: ProjectStore;
  exportDir: string;
}

function define<S extends z.ZodRawShape>(c: Command<S>): Command<S> {
  return c;
}

// ---- Helpers ------------------------------------------------------------------

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const toTick = (p: Project, beats: number) => Math.max(0, Math.round(beats * p.ppq));
const toBeats = (p: Project, ticks: number) => round(ticks / p.ppq);

function posLabel(p: Project, tick: number) {
  const { bar, beat } = tickToBarBeat(p, tick);
  return `${bar}.${round(beat, 2)}`;
}

export function describeNote(p: Project, n: Note, track?: Track) {
  return {
    id: n.id,
    ...(track ? { trackId: track.id } : {}),
    pitch: n.pitch,
    name: pitchName(n.pitch),
    beat: toBeats(p, n.tick),
    duration: toBeats(p, n.duration),
    velocity: n.velocity,
    pos: posLabel(p, n.tick),
    ...(n.hand ? { hand: n.hand } : {}),
  };
}

function findTrack(p: Project, trackId?: string): Track {
  if (!trackId) {
    if (p.tracks.length === 1) return p.tracks[0];
    if (p.tracks.length === 0) throw new Error("This project has no tracks yet. Create one with add_track.");
    throw new Error(`trackId is required — this project has ${p.tracks.length} tracks: ${p.tracks.map((t) => `${t.id} (${t.name})`).join(", ")}`);
  }
  const t = p.tracks.find((t) => t.id === trackId || t.name.toLowerCase() === trackId.toLowerCase());
  if (!t) throw new Error(`Track not found: ${trackId}`);
  return t;
}

const pitchInput = z.union([z.number().int().min(0).max(127), z.string()]).describe('MIDI number (60 = middle C) or a note name like "C4", "F#3", "Bb2"');

/** Shared way of targeting notes. */
const selectorShape = {
  noteIds: z.array(z.string()).optional().describe("Specific note ids."),
  useSelection: z.boolean().optional().describe("Target the notes the user has selected in the editor."),
  trackId: z.string().optional().describe("Limit to one track (id or name)."),
  startBeat: z.number().optional().describe("Notes starting at or after this beat (0 = start of song)."),
  endBeat: z.number().optional().describe("Notes starting before this beat."),
  lowPitch: pitchInput.optional(),
  highPitch: pitchInput.optional(),
  hand: z.enum(["left", "right", "none"]).optional().describe('Only notes played by this hand ("none" = not assigned yet).'),
  all: z.boolean().optional().describe("Target every note in the project (or in trackId). Required when no other filter is given."),
};
type Selector = { [K in keyof typeof selectorShape]?: z.infer<(typeof selectorShape)[K]> };

function selectNotes(ctx: CommandContext, p: Project, s: Selector): { note: Note; track: Track }[] {
  const ids = new Set<string>(s.noteIds ?? []);
  if (s.useSelection) {
    if (ctx.store.selection.projectId === p.id) for (const id of ctx.store.selection.noteIds) ids.add(id);
    if (ids.size === 0) throw new Error("The user has no notes selected.");
  }
  const hasFilter = s.trackId || s.startBeat !== undefined || s.endBeat !== undefined || s.lowPitch !== undefined || s.highPitch !== undefined || s.hand !== undefined;
  if (ids.size === 0 && !hasFilter && !s.all) {
    throw new Error("No notes targeted. Pass noteIds, useSelection, a filter (trackId/startBeat/endBeat/lowPitch/highPitch/hand) or all: true.");
  }
  const tracks = s.trackId ? [findTrack(p, s.trackId)] : p.tracks;
  const lo = s.lowPitch !== undefined ? parsePitch(s.lowPitch) : 0;
  const hi = s.highPitch !== undefined ? parsePitch(s.highPitch) : 127;
  const start = s.startBeat !== undefined ? toTick(p, s.startBeat) : -Infinity;
  const end = s.endBeat !== undefined ? toTick(p, s.endBeat) : Infinity;
  const out: { note: Note; track: Track }[] = [];
  for (const track of tracks) {
    for (const note of track.notes) {
      if (ids.size && !ids.has(note.id)) continue;
      if (note.pitch < lo || note.pitch > hi || note.tick < start || note.tick >= end) continue;
      if (s.hand && (note.hand ?? "none") !== s.hand) continue;
      out.push({ note, track });
    }
  }
  return out;
}

function sortNotes(track: Track) {
  track.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

function rangeFromBars(p: Project, a: { startBar?: number; endBar?: number }, defaultBars = Infinity) {
  const startBar = a.startBar ?? 1;
  const endTickSong = projectEndTick(p);
  const endBar = a.endBar ?? (defaultBars === Infinity ? undefined : startBar + defaultBars - 1);
  const startTick = barBeatToTick(p, startBar);
  const endTick = endBar !== undefined ? barBeatToTick(p, endBar + 1) : Math.max(endTickSong, startTick + p.ppq * 4);
  return { startTick, endTick };
}

function projectOverview(ctx: CommandContext, p: Project) {
  const end = projectEndTick(p);
  const allNotes = p.tracks.filter((t) => t.channel !== 9).flatMap((t) => t.notes);
  return {
    id: p.id,
    name: p.name,
    ppq: p.ppq,
    tempos: p.tempos.map((t) => ({ beat: toBeats(p, t.tick), pos: posLabel(p, t.tick), bpm: t.bpm })),
    timeSignatures: p.timeSignatures.map((t) => ({ beat: toBeats(p, t.tick), pos: posLabel(p, t.tick), signature: `${t.numerator}/${t.denominator}` })),
    declaredKey: p.keySignature ?? null,
    detectedKeys: detectKey(allNotes),
    length: { beats: toBeats(p, end), bars: end ? tickToBarBeat(p, Math.max(0, end - 1)).bar : 0, seconds: round(ticksToSeconds(p, end), 1) },
    tracks: p.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      instrument: t.channel === 9 ? "Drum kit (channel 10)" : GM_PROGRAMS[t.program],
      program: t.program,
      channel: t.channel,
      muted: t.muted,
      solo: t.solo,
      ...trackStats(p, t),
    })),
    userSelection: ctx.store.selection.projectId === p.id ? ctx.store.selection.noteIds.length : 0,
    canUndo: ctx.store.canUndo(p.id),
  };
}

// ---- Commands -------------------------------------------------------------------

const projectId = z.string().optional().describe("Project id. Defaults to the project open in the editor.");

export const commands: Command<any>[] = [
  // Projects ---------------------------------------------------------------------
  define({
    name: "list_projects",
    title: "List projects",
    description: "List all projects and which one is open in the editor.",
    input: {},
    readOnly: true,
    run: ({ store }) => ({ data: { activeProjectId: store.activeProjectId, projects: store.list() } }),
  }),
  define({
    name: "create_project",
    title: "Create project",
    description: "Create a new empty project and open it in the editor. By default it gets one piano track.",
    input: {
      name: z.string().default("Untitled"),
      bpm: z.number().min(10).max(400).default(120),
      timeSignature: z.string().regex(/^\d+\/\d+$/).default("4/4").describe('e.g. "4/4", "3/4", "6/8"'),
      keySignature: z.string().optional().describe('e.g. "C major", "A minor"'),
      withPianoTrack: z.boolean().default(true),
    },
    run: ({ store }, a) => {
      const [num, den] = a.timeSignature.split("/").map(Number);
      const p = emptyProject(a.name, { bpm: a.bpm, numerator: num, denominator: den });
      if (a.keySignature) p.keySignature = a.keySignature;
      if (a.withPianoTrack) p.tracks.push(newTrack(p, { name: "Piano", program: 0 }));
      store.add(p);
      return { data: projectOverview({ store, exportDir: "" }, p), summary: `Created project “${p.name}”` };
    },
  }),
  define({
    name: "open_project",
    title: "Open project",
    description: "Open a project in the editor so the user sees it.",
    input: { projectId: z.string() },
    run: ({ store }, a) => {
      store.setActive(a.projectId);
      return { data: { opened: a.projectId }, summary: `Opened “${store.resolve(a.projectId).name}”` };
    },
  }),
  define({
    name: "update_project",
    title: "Update project",
    description: "Rename the project or set its key signature.",
    input: { projectId, name: z.string().optional(), keySignature: z.string().nullable().optional() },
    run: ({ store }, a) => {
      store.mutate(a.projectId, "Update project", (p) => {
        if (a.name !== undefined) p.name = a.name;
        if (a.keySignature !== undefined) p.keySignature = a.keySignature ?? undefined;
      });
      return { data: { ok: true }, summary: `Updated project settings` };
    },
  }),
  define({
    name: "delete_project",
    title: "Delete project",
    description: "Permanently delete a project.",
    input: { projectId: z.string() },
    run: ({ store }, a) => {
      const name = store.resolve(a.projectId).name;
      store.remove(a.projectId);
      return { data: { deleted: a.projectId }, summary: `Deleted project “${name}”` };
    },
  }),
  define({
    name: "import_midi",
    title: "Import MIDI file",
    description: "Import a Standard MIDI File (.mid) from a path on the server's disk, or from base64 data, as a new project and open it.",
    input: {
      path: z.string().optional().describe("Absolute path to a .mid file."),
      base64: z.string().optional().describe("The file contents, base64-encoded."),
      name: z.string().optional(),
    },
    run: ({ store }, a) => {
      let bytes: Uint8Array;
      if (a.path) bytes = fs.readFileSync(a.path);
      else if (a.base64) bytes = Buffer.from(a.base64, "base64");
      else throw new Error("Provide path or base64.");
      const name = a.name ?? (a.path ? path.basename(a.path).replace(/\.midi?$/i, "") : "Imported");
      const p = midiToProject(bytes, name);
      store.add(p);
      return { data: projectOverview({ store, exportDir: "" }, p), summary: `Imported “${name}”` };
    },
  }),
  define({
    name: "export_midi",
    title: "Export MIDI file",
    description: "Write the project to a Standard MIDI File on the server's disk. Returns the file path.",
    input: { projectId, path: z.string().optional().describe("Destination path. Defaults to the exports folder.") },
    readOnly: true,
    run: (ctx, a) => {
      const p = ctx.store.resolve(a.projectId);
      const dest = a.path ?? path.join(ctx.exportDir, `${p.name.replace(/[^\w\- ]+/g, "_") || p.id}.mid`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, projectToMidi(p));
      return { data: { path: dest }, summary: `Exported to ${dest}` };
    },
  }),

  // Understanding ----------------------------------------------------------------------
  define({
    name: "get_project",
    title: "Get project overview",
    description:
      "Start here. Returns tempo, time signature, declared and detected key, length, and every track with its instrument, range, polyphony and role. Times are in beats (quarter notes, 0 = start) and pos is bar.beat (1-based).",
    input: { projectId },
    readOnly: true,
    run: (ctx, a) => ({ data: projectOverview(ctx, ctx.store.resolve(a.projectId)) }),
  }),
  define({
    name: "get_notes",
    title: "Get notes",
    description:
      "List notes with id, pitch, name, beat (start, in quarter notes from 0), duration (beats), velocity and pos (bar.beat). Filter by track, beats or bars, and pitch range. Use the ids to edit notes.",
    input: {
      projectId,
      trackId: z.string().optional(),
      startBar: z.number().int().min(1).optional().describe("First bar to include (1-based)."),
      endBar: z.number().int().min(1).optional().describe("Last bar to include (inclusive)."),
      startBeat: z.number().optional(),
      endBeat: z.number().optional(),
      lowPitch: pitchInput.optional(),
      highPitch: pitchInput.optional(),
      hand: z.enum(["left", "right", "none"]).optional().describe("Only notes played by this hand."),
      useSelection: z.boolean().optional().describe("Only the notes the user has selected."),
      limit: z.number().int().min(1).max(5000).default(500),
    },
    readOnly: true,
    run: (ctx, a) => {
      const p = ctx.store.resolve(a.projectId);
      let startBeat = a.startBeat;
      let endBeat = a.endBeat;
      if (a.startBar !== undefined) startBeat = toBeats(p, barBeatToTick(p, a.startBar));
      if (a.endBar !== undefined) endBeat = toBeats(p, barBeatToTick(p, a.endBar + 1));
      const sel = selectNotes(ctx, p, { trackId: a.trackId, startBeat, endBeat, lowPitch: a.lowPitch, highPitch: a.highPitch, hand: a.hand, useSelection: a.useSelection, all: true });
      sel.sort((x, y) => x.note.tick - y.note.tick || x.note.pitch - y.note.pitch);
      const multi = !a.trackId && p.tracks.length > 1;
      return {
        data: {
          total: sel.length,
          truncated: sel.length > a.limit,
          notes: sel.slice(0, a.limit).map(({ note, track }) => describeNote(p, note, multi ? track : undefined)),
        },
      };
    },
  }),
  define({
    name: "render_piano_roll",
    title: "Render piano roll",
    description:
      "Draw a section as a text piano roll so you can see melodic shape, rhythm and voicing at a glance. Rows are pitches (high at top); # = note start (L or R when the note's hand is known), = = held, | = bar line, : = beat.",
    input: {
      projectId,
      startBar: z.number().int().min(1).default(1),
      endBar: z.number().int().min(1).optional().describe("Defaults to startBar + 3."),
      trackIds: z.array(z.string()).optional(),
      grid: z.enum(["1/4", "1/8", "1/16", "1/32"]).default("1/16").describe("Width of one column."),
    },
    readOnly: true,
    run: (ctx, a) => {
      const p = ctx.store.resolve(a.projectId);
      const { startTick, endTick } = rangeFromBars(p, { startBar: a.startBar, endBar: a.endBar ?? a.startBar + 3 });
      const stepTicks = (p.ppq * 4) / Number(a.grid.split("/")[1]);
      const trackIds = a.trackIds?.map((id) => findTrack(p, id).id);
      return { data: renderPianoRoll(p, { startTick, endTick, stepTicks, trackIds }) };
    },
  }),
  define({
    name: "analyze_harmony",
    title: "Analyze harmony",
    description:
      "Detect the key and the chord progression (drums excluded). Returns chords with their bar.beat position; consecutive repeats are collapsed. When notes have hands assigned, the left hand counts fully and a lone right-hand melody counts less, so passing tones don't distort the chords — assign hands first (auto_assign_hands) for better results on piano music.",
    input: {
      projectId,
      startBar: z.number().int().min(1).optional(),
      endBar: z.number().int().min(1).optional(),
      trackIds: z.array(z.string()).optional(),
      resolution: z.enum(["bar", "half-bar", "beat"]).default("half-bar"),
      useHands: z.boolean().default(true).describe("Weight notes by hand when hands are assigned."),
    },
    readOnly: true,
    run: (ctx, a) => {
      const p = ctx.store.resolve(a.projectId);
      const { startTick, endTick } = rangeFromBars(p, a);
      const trackIds = a.trackIds?.map((id) => findTrack(p, id).id);
      const notes = p.tracks
        .filter((t) => t.channel !== 9 && (!trackIds || trackIds.includes(t.id)))
        .flatMap((t) => t.notes)
        .filter((n) => n.tick < endTick && n.tick + n.duration > startTick);
      return {
        data: {
          declaredKey: p.keySignature ?? null,
          detectedKeys: detectKey(notes),
          ...(() => {
            const prog = chordProgression(p, { resolution: a.resolution, startTick, endTick, trackIds, useHands: a.useHands });
            return {
              weightedByHand: prog.usedHands,
              chords: prog.chords.map((c) => ({ pos: `${c.bar}.${c.beat}`, chord: c.chord, pitchClasses: c.pitchClasses })),
            };
          })(),
        },
      };
    },
  }),
  define({
    name: "get_editor_state",
    title: "Get editor state",
    description: "What the user is doing right now: the open project, the selected notes, and the playhead position.",
    input: {},
    readOnly: true,
    run: ({ store }) => {
      const p = store.activeProjectId ? store.get(store.activeProjectId) : undefined;
      const selected = p ? p.tracks.flatMap((t) => t.notes.filter((n) => store.selection.noteIds.includes(n.id)).map((n) => describeNote(p, n, t))) : [];
      return {
        data: {
          activeProject: p ? { id: p.id, name: p.name } : null,
          playing: store.playback.playing,
          playhead: p ? { beat: toBeats(p, store.playback.tick), pos: posLabel(p, store.playback.tick) } : null,
          selectedNotes: selected,
        },
      };
    },
  }),

  // Tracks ---------------------------------------------------------------------------
  define({
    name: "add_track",
    title: "Add track",
    description: "Add a track. Pick an instrument with a General MIDI program (0 = piano, 33 = finger bass, 48 = strings, 73 = flute…) or set drums: true for a drum kit on channel 10.",
    input: {
      projectId,
      name: z.string().optional(),
      program: z.number().int().min(0).max(127).default(0),
      drums: z.boolean().default(false),
    },
    run: ({ store }, a) => {
      const { result } = store.mutate(a.projectId, "Add track", (p) => {
        const t = newTrack(p, { name: a.name, program: a.program, ...(a.drums ? { channel: 9 } : {}) });
        p.tracks.push(t);
        return t;
      });
      return { data: { trackId: result.id, name: result.name, channel: result.channel }, summary: `Added track “${result.name}”` };
    },
  }),
  define({
    name: "update_track",
    title: "Update track",
    description: "Change a track's name, instrument (GM program), channel, color, mute or solo.",
    input: {
      projectId,
      trackId: z.string(),
      name: z.string().optional(),
      program: z.number().int().min(0).max(127).optional(),
      channel: z.number().int().min(0).max(15).optional(),
      color: z.string().optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
    },
    run: ({ store }, a) => {
      const { result } = store.mutate(a.projectId, "Update track", (p) => {
        const t = findTrack(p, a.trackId);
        for (const k of ["name", "program", "channel", "color", "muted", "solo"] as const) if (a[k] !== undefined) (t as any)[k] = a[k];
        return t.name;
      });
      return { data: { ok: true }, summary: `Updated track “${result}”` };
    },
  }),
  define({
    name: "delete_track",
    title: "Delete track",
    description: "Delete a track and all of its notes.",
    input: { projectId, trackId: z.string() },
    run: ({ store }, a) => {
      const { result } = store.mutate(a.projectId, "Delete track", (p) => {
        const t = findTrack(p, a.trackId);
        p.tracks = p.tracks.filter((x) => x !== t);
        return t.name;
      });
      return { data: { ok: true }, summary: `Deleted track “${result}”` };
    },
  }),

  // Notes ------------------------------------------------------------------------------
  define({
    name: "add_notes",
    title: "Add notes",
    description:
      "Add notes to a track. beat is the start in quarter notes from the song start (0 = bar 1 beat 1; in 4/4 bar 2 starts at beat 4). duration is in beats (1 = quarter, 0.5 = eighth). Returns the new note ids.",
    input: {
      projectId,
      trackId: z.string().optional().describe("Track id or name. Optional when there is exactly one track."),
      notes: z
        .array(
          z.object({
            pitch: pitchInput,
            beat: z.number().min(0),
            duration: z.number().positive().default(1),
            velocity: z.number().int().min(1).max(127).default(90),
          }),
        )
        .min(1),
    },
    run: ({ store }, a) => {
      const { project, result } = store.mutate(a.projectId, `Add ${a.notes.length} notes`, (p) => {
        const t = findTrack(p, a.trackId);
        const added = a.notes.map((n) => ({
          id: newId("n_"),
          pitch: parsePitch(n.pitch),
          tick: toTick(p, n.beat),
          duration: Math.max(1, Math.round(n.duration * p.ppq)),
          velocity: n.velocity,
        }));
        t.notes.push(...added);
        sortNotes(t);
        return { track: t, added };
      });
      return {
        data: { trackId: result.track.id, noteIds: result.added.map((n) => n.id) },
        summary: `Added ${result.added.length} note${result.added.length === 1 ? "" : "s"} to “${result.track.name}”` + (result.added.length ? ` at ${posLabel(project, result.added[0].tick)}` : ""),
      };
    },
  }),
  define({
    name: "update_notes",
    title: "Update notes",
    description: "Change individual notes by id: pitch, start beat, duration, velocity, or move them to another track.",
    input: {
      projectId,
      updates: z
        .array(
          z.object({
            id: z.string(),
            pitch: pitchInput.optional(),
            beat: z.number().min(0).optional(),
            duration: z.number().positive().optional(),
            velocity: z.number().int().min(1).max(127).optional(),
            trackId: z.string().optional().describe("Move the note to this track."),
          }),
        )
        .min(1),
    },
    run: ({ store }, a) => {
      store.mutate(a.projectId, `Edit ${a.updates.length} notes`, (p) => {
        const index = new Map<string, { note: Note; track: Track }>();
        for (const t of p.tracks) for (const n of t.notes) index.set(n.id, { note: n, track: t });
        const touched = new Set<Track>();
        for (const u of a.updates) {
          const hit = index.get(u.id);
          if (!hit) throw new Error(`Note not found: ${u.id}`);
          const { note } = hit;
          if (u.pitch !== undefined) note.pitch = parsePitch(u.pitch);
          if (u.beat !== undefined) note.tick = toTick(p, u.beat);
          if (u.duration !== undefined) note.duration = Math.max(1, Math.round(u.duration * p.ppq));
          if (u.velocity !== undefined) note.velocity = u.velocity;
          touched.add(hit.track);
          if (u.trackId) {
            const dest = findTrack(p, u.trackId);
            if (dest !== hit.track) {
              hit.track.notes = hit.track.notes.filter((n) => n !== note);
              dest.notes.push(note);
              index.set(u.id, { note, track: dest });
              touched.add(dest);
            }
          }
        }
        touched.forEach(sortNotes);
      });
      return { data: { updated: a.updates.length }, summary: `Edited ${a.updates.length} note${a.updates.length === 1 ? "" : "s"}` };
    },
  }),
  define({
    name: "delete_notes",
    title: "Delete notes",
    description: "Delete notes by id, by the user's selection, or by a filter (track, beat range, pitch range).",
    input: { projectId, ...selectorShape },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Delete notes", (p) => {
        const targets = new Set(selectNotes(ctx, p, a).map((x) => x.note));
        for (const t of p.tracks) t.notes = t.notes.filter((n) => !targets.has(n));
        return targets.size;
      });
      return { data: { deleted: result }, summary: `Deleted ${result} note${result === 1 ? "" : "s"}` };
    },
  }),
  define({
    name: "transform_notes",
    title: "Transform notes",
    description:
      "Apply a transformation to targeted notes: transpose (semitones), shift in time (beats), stretch durations/timing, set or scale velocity, or humanize. Target notes by ids, the user's selection, or a filter.",
    input: {
      projectId,
      ...selectorShape,
      transpose: z.number().int().optional().describe("Semitones, e.g. 12 = up an octave."),
      shiftBeats: z.number().optional().describe("Move later (+) or earlier (−) by this many beats."),
      stretch: z.number().positive().optional().describe("Multiply start offsets (from the first targeted note) and durations, e.g. 2 = half speed."),
      durationBeats: z.number().positive().optional().describe("Set every targeted note to this duration."),
      legato: z.boolean().optional().describe("Extend each note to the start of the next note in the same track."),
      velocity: z.number().int().min(1).max(127).optional().describe("Set velocity."),
      velocityScale: z.number().positive().optional().describe("Multiply velocity, e.g. 0.8 for softer."),
      humanize: z.object({ timingBeats: z.number().min(0).default(0.02), velocity: z.number().int().min(0).default(8) }).optional().describe("Random timing and velocity variation."),
    },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Transform notes", (p) => {
        const sel = selectNotes(ctx, p, a);
        if (sel.length === 0) return 0;
        const anchor = Math.min(...sel.map((s) => s.note.tick));
        const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));
        for (const { note } of sel) {
          if (a.transpose) {
            note.pitch += a.transpose;
            if (note.pitch < 0 || note.pitch > 127) throw new Error(`Transposing ${pitchName(note.pitch - a.transpose)} by ${a.transpose} leaves the MIDI range.`);
          }
          if (a.stretch) {
            note.tick = Math.round(anchor + (note.tick - anchor) * a.stretch);
            note.duration = Math.max(1, Math.round(note.duration * a.stretch));
          }
          if (a.shiftBeats) note.tick = note.tick + Math.round(a.shiftBeats * p.ppq);
          if (note.tick < 0) throw new Error("Shift would move notes before the start of the song.");
          if (a.durationBeats) note.duration = Math.max(1, Math.round(a.durationBeats * p.ppq));
          if (a.velocity) note.velocity = a.velocity;
          if (a.velocityScale) note.velocity = clampVel(note.velocity * a.velocityScale);
          if (a.humanize) {
            const j = Math.round((Math.random() * 2 - 1) * a.humanize.timingBeats * p.ppq);
            note.tick = Math.max(0, note.tick + j);
            note.velocity = clampVel(note.velocity + (Math.random() * 2 - 1) * a.humanize.velocity);
          }
        }
        if (a.legato) {
          const targeted = new Set(sel.map((s) => s.note));
          for (const t of new Set(sel.map((s) => s.track))) {
            sortNotes(t);
            const starts = [...new Set(t.notes.map((n) => n.tick))].sort((x, y) => x - y);
            for (const n of t.notes) {
              if (!targeted.has(n)) continue;
              const next = starts.find((s) => s > n.tick);
              if (next !== undefined) n.duration = next - n.tick;
            }
          }
        }
        new Set(sel.map((s) => s.track)).forEach(sortNotes);
        return sel.length;
      });
      const ops = ["transpose", "shiftBeats", "stretch", "durationBeats", "legato", "velocity", "velocityScale", "humanize"].filter((k) => (a as any)[k] !== undefined);
      return { data: { transformed: result }, summary: `Transformed ${result} notes (${ops.join(", ")})` };
    },
  }),
  define({
    name: "quantize_notes",
    title: "Quantize notes",
    description: "Snap note starts (and optionally ends) to a grid.",
    input: {
      projectId,
      ...selectorShape,
      grid: z.number().positive().default(0.25).describe("Grid size in beats: 1 = quarter, 0.5 = eighth, 0.25 = sixteenth, 1/3 = eighth-note triplet."),
      strength: z.number().min(0).max(1).default(1).describe("1 = snap fully, 0.5 = halfway."),
      quantizeEnds: z.boolean().default(false),
    },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Quantize", (p) => {
        const g = a.grid * p.ppq;
        const sel = selectNotes(ctx, p, a);
        for (const { note } of sel) {
          const end = note.tick + note.duration;
          note.tick = Math.round(note.tick + (Math.round(note.tick / g) * g - note.tick) * a.strength);
          if (a.quantizeEnds) {
            const qEnd = Math.round(end + (Math.round(end / g) * g - end) * a.strength);
            note.duration = Math.max(Math.round(g * a.strength) || 1, qEnd - note.tick);
          } else note.duration = Math.max(1, end - note.tick);
        }
        new Set(sel.map((s) => s.track)).forEach(sortNotes);
        return sel.length;
      });
      return { data: { quantized: result }, summary: `Quantized ${result} notes to ${a.grid} beat grid` };
    },
  }),
  define({
    name: "copy_notes",
    title: "Copy notes",
    description: "Duplicate targeted notes to another time and/or track — e.g. repeat a 4-bar phrase, or double a melody an octave up on another instrument.",
    input: {
      projectId,
      ...selectorShape,
      toBeat: z.number().min(0).optional().describe("Where the earliest copied note lands."),
      offsetBeats: z.number().optional().describe("Alternatively, shift copies by this many beats."),
      toTrackId: z.string().optional().describe("Paste into this track (defaults to each note's own track)."),
      transpose: z.number().int().default(0),
      times: z.number().int().min(1).max(64).default(1).describe("Repeat the copy this many times back to back (with offsetBeats as the step)."),
    },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Copy notes", (p) => {
        const sel = selectNotes(ctx, p, a);
        if (sel.length === 0) return [];
        const first = Math.min(...sel.map((s) => s.note.tick));
        const last = Math.max(...sel.map((s) => s.note.tick + s.note.duration));
        let step: number;
        if (a.toBeat !== undefined) step = toTick(p, a.toBeat) - first;
        else if (a.offsetBeats !== undefined) step = Math.round(a.offsetBeats * p.ppq);
        else step = last - first;
        const dest = a.toTrackId ? findTrack(p, a.toTrackId) : null;
        const ids: string[] = [];
        for (let i = 1; i <= a.times; i++) {
          for (const { note, track } of sel) {
            const copy = { ...note, id: newId("n_"), tick: note.tick + step * i, pitch: note.pitch + a.transpose };
            if (copy.tick < 0 || copy.pitch < 0 || copy.pitch > 127) throw new Error("Copy would fall outside the song or the MIDI pitch range.");
            (dest ?? track).notes.push(copy);
            ids.push(copy.id);
          }
        }
        p.tracks.forEach(sortNotes);
        return ids;
      });
      return { data: { noteIds: result }, summary: `Copied ${result.length} notes` };
    },
  }),

  // Hands ------------------------------------------------------------------------------
  define({
    name: "set_hand",
    title: "Set hand",
    description: "Mark notes as played by the left or right hand (or clear the mark with setTo: null). Hands drive the hand-colored view and make analyze_harmony more accurate.",
    input: { projectId, ...selectorShape, setTo: z.enum(["left", "right"]).nullable().describe("The hand to assign, or null to clear.") },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Set hand", (p) => {
        const sel = selectNotes(ctx, p, a);
        for (const { note } of sel) {
          if (a.setTo) note.hand = a.setTo;
          else delete note.hand;
        }
        return sel.length;
      });
      return { data: { updated: result }, summary: a.setTo ? `Marked ${result} notes as ${a.setTo} hand` : `Cleared hand on ${result} notes` };
    },
  }),
  define({
    name: "auto_assign_hands",
    title: "Auto-assign hands",
    description:
      "Guess the left/right hand for notes from their pitch and voicing, following the hands as they move. By default only notes without a hand are changed, so marks the user painted are kept. Targets all non-drum notes unless a selector is given.",
    input: {
      projectId,
      ...selectorShape,
      splitPitch: pitchInput.optional().describe("Use a fixed split point instead: notes below it go to the left hand."),
      overwrite: z.boolean().default(false).describe("Also re-assign notes that already have a hand."),
    },
    run: (ctx, a) => {
      const { result } = ctx.store.mutate(a.projectId, "Auto-assign hands", (p) => {
        const hasTarget = a.noteIds || a.useSelection || a.trackId || a.startBeat !== undefined || a.endBeat !== undefined || a.lowPitch !== undefined || a.highPitch !== undefined || a.hand;
        const sel = selectNotes(ctx, p, hasTarget ? a : { ...a, all: true }).filter(({ track }) => track.channel !== 9);
        const counts = { left: 0, right: 0 };
        // Assign per track: hands are a property of one player's part.
        for (const track of new Set(sel.map((s) => s.track))) {
          const notes = sel.filter((s) => s.track === track).map((s) => s.note);
          const guess = assignHands(notes, p.ppq, { splitPitch: a.splitPitch !== undefined ? parsePitch(a.splitPitch) : undefined });
          for (const [note, hand] of guess) {
            if (note.hand && !a.overwrite) continue;
            note.hand = hand as Hand;
            counts[hand]++;
          }
        }
        return counts;
      });
      return { data: result, summary: `Assigned hands: ${result.left} left, ${result.right} right` };
    },
  }),

  // Tempo & meter ------------------------------------------------------------------------
  define({
    name: "set_tempo",
    title: "Set tempo",
    description: "Set the tempo in BPM. With no beat, replaces the whole tempo map with a single tempo; with a beat, adds or replaces a tempo change there.",
    input: { projectId, bpm: z.number().min(10).max(400), beat: z.number().min(0).optional() },
    run: ({ store }, a) => {
      store.mutate(a.projectId, "Set tempo", (p) => {
        if (a.beat === undefined) p.tempos = [{ tick: 0, bpm: a.bpm }];
        else {
          const tick = toTick(p, a.beat);
          p.tempos = p.tempos.filter((t) => t.tick !== tick).concat({ tick, bpm: a.bpm }).sort((x, y) => x.tick - y.tick);
        }
      });
      return { data: { ok: true }, summary: `Tempo set to ${a.bpm} BPM${a.beat ? ` at beat ${a.beat}` : ""}` };
    },
  }),
  define({
    name: "set_time_signature",
    title: "Set time signature",
    description: "Set the time signature. With no bar, replaces it for the whole song; with a bar number, changes it from that bar on.",
    input: { projectId, timeSignature: z.string().regex(/^\d+\/\d+$/), bar: z.number().int().min(1).optional() },
    run: ({ store }, a) => {
      store.mutate(a.projectId, "Set time signature", (p) => {
        const [numerator, denominator] = a.timeSignature.split("/").map(Number);
        if (!a.bar || a.bar === 1) {
          p.timeSignatures = a.bar ? [{ tick: 0, numerator, denominator }, ...p.timeSignatures.filter((t) => t.tick > 0)] : [{ tick: 0, numerator, denominator }];
        } else {
          const tick = barBeatToTick(p, a.bar);
          p.timeSignatures = p.timeSignatures.filter((t) => t.tick !== tick).concat({ tick, numerator, denominator }).sort((x, y) => x.tick - y.tick);
        }
      });
      return { data: { ok: true }, summary: `Time signature ${a.timeSignature}${a.bar ? ` from bar ${a.bar}` : ""}` };
    },
  }),

  // History ------------------------------------------------------------------------------
  define({
    name: "undo",
    title: "Undo",
    description: "Undo the last change (by anyone — you or the user).",
    input: { projectId },
    run: ({ store }, a) => {
      const label = store.undo(a.projectId);
      return { data: { undone: label }, summary: `Undid “${label}”` };
    },
  }),
  define({
    name: "redo",
    title: "Redo",
    description: "Redo the last undone change.",
    input: { projectId },
    run: ({ store }, a) => {
      const label = store.redo(a.projectId);
      return { data: { redone: label }, summary: `Redid “${label}”` };
    },
  }),

  // Editor control ----------------------------------------------------------------------------
  define({
    name: "play",
    title: "Play",
    description: "Start playback in the user's editor, optionally from a bar, so they can hear a change.",
    input: { fromBar: z.number().int().min(1).optional() },
    run: ({ store }, a) => {
      const p = store.resolve();
      const tick = a.fromBar ? barBeatToTick(p, a.fromBar) : undefined;
      store.emit("playback", "play", tick);
      return { data: { ok: true }, summary: a.fromBar ? `Playing from bar ${a.fromBar}` : "Playing" };
    },
  }),
  define({
    name: "stop",
    title: "Stop",
    description: "Stop playback in the user's editor.",
    input: {},
    run: ({ store }) => {
      store.emit("playback", "pause");
      return { data: { ok: true }, summary: "Stopped playback" };
    },
  }),
  define({
    name: "highlight_notes",
    title: "Highlight notes",
    description: "Select notes in the user's editor to point something out (e.g. “these two notes clash”).",
    input: { projectId, ...selectorShape },
    run: (ctx, a) => {
      const p = ctx.store.resolve(a.projectId);
      const ids = selectNotes(ctx, p, a).map((x) => x.note.id);
      ctx.store.setSelection({ projectId: p.id, noteIds: ids });
      ctx.store.emit("select", ids);
      return { data: { highlighted: ids.length }, summary: `Highlighted ${ids.length} notes` };
    },
  }),
];

export const commandMap = new Map(commands.map((c) => [c.name, c]));

/** Validates args and runs a command, logging it to the activity feed. */
export async function runCommand(ctx: CommandContext, name: string, rawArgs: unknown, source: "agent" | "user"): Promise<unknown> {
  const cmd = commandMap.get(name);
  if (!cmd) throw new Error(`Unknown command: ${name}`);
  const args = z.object(cmd.input).parse(rawArgs ?? {});
  try {
    const res = await cmd.run(ctx, args);
    if (res.summary) ctx.store.logActivity({ source, tool: name, summary: res.summary, ok: true });
    return res.data;
  } catch (e) {
    if (!cmd.readOnly) ctx.store.logActivity({ source, tool: name, summary: (e as Error).message, ok: false });
    throw e;
  }
}
