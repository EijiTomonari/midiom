// Core data model shared by the server, the MCP tools and the web UI.
// Time is stored in ticks (PPQ = ticks per quarter note). The MCP tools speak
// in beats (quarter notes) because that's how musicians — and agents — think.

export interface Note {
  id: string;
  /** MIDI pitch, 0-127 (60 = C4). */
  pitch: number;
  /** Start time in ticks. */
  tick: number;
  /** Duration in ticks. */
  duration: number;
  /** Velocity, 1-127. */
  velocity: number;
  /** Which hand plays this note (piano parts). Unset = not assigned. */
  hand?: Hand;
}

export type Hand = "left" | "right";

export interface Track {
  id: string;
  name: string;
  /** MIDI channel 0-15 (9 = drums). */
  channel: number;
  /** General MIDI program 0-127. */
  program: number;
  color: string;
  muted: boolean;
  solo: boolean;
  notes: Note[];
}

export interface TempoEvent {
  tick: number;
  bpm: number;
}

export interface TimeSignatureEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface Project {
  id: string;
  name: string;
  ppq: number;
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  /** Optional key signature hint, e.g. "C major", "A minor". */
  keySignature?: string;
  tracks: Track[];
  createdAt: string;
  updatedAt: string;
  /** Incremented on every change. */
  version: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  trackCount: number;
  noteCount: number;
  updatedAt: string;
}

/** What the human currently has selected in the editor. */
export interface Selection {
  projectId: string | null;
  noteIds: string[];
  /** Optional time range the user is looking at / has highlighted, in ticks. */
  range?: { startTick: number; endTick: number };
}

export interface PlaybackState {
  playing: boolean;
  /** Current position in ticks. */
  tick: number;
}

export interface ActivityEvent {
  id: string;
  time: string;
  source: "agent" | "user";
  tool: string;
  summary: string;
  ok: boolean;
}

// ---- WebSocket protocol -------------------------------------------------

export type ServerMessage =
  | { type: "hello"; projects: ProjectSummary[]; activeProjectId: string | null; activity: ActivityEvent[] }
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "project"; project: Project; canUndo: boolean; canRedo: boolean }
  | { type: "active"; projectId: string | null }
  | { type: "activity"; event: ActivityEvent }
  | { type: "playback"; action: "play" | "pause" | "stop" | "seek"; tick?: number }
  | { type: "select"; noteIds: string[] }
  | { type: "error"; message: string; requestId?: string }
  | { type: "result"; requestId: string; result: unknown };

export type ClientMessage =
  | { type: "open"; projectId: string }
  | { type: "command"; requestId?: string; name: string; args: Record<string, unknown> }
  | { type: "selection"; noteIds: string[]; range?: { startTick: number; endTick: number } }
  | { type: "playback"; playing: boolean; tick: number };
