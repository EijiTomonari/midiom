import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ActivityEvent, PlaybackState, Project, ProjectSummary, Selection } from "../shared/types";

const MAX_HISTORY = 200;

interface History {
  undo: string[];
  redo: string[];
  labels: { undo: string[]; redo: string[] };
}

export interface StoreEvents {
  project: [project: Project];
  projects: [projects: ProjectSummary[]];
  active: [projectId: string | null];
  activity: [event: ActivityEvent];
  playback: [action: "play" | "pause" | "stop" | "seek", tick?: number];
  select: [noteIds: string[]];
}

export function newId(prefix = ""): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 10);
}

/**
 * Holds every project in memory, persists them to disk as JSON, keeps an undo
 * history per project and broadcasts changes so the UI and the agent always see
 * the same state.
 */
export class ProjectStore extends EventEmitter<StoreEvents> {
  private projects = new Map<string, Project>();
  private history = new Map<string, History>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  activeProjectId: string | null = null;
  selection: Selection = { projectId: null, noteIds: [] };
  playback: PlaybackState = { playing: false, tick: 0 };
  activity: ActivityEvent[] = [];

  constructor(private dataDir: string | null) {
    super();
    if (dataDir) this.loadAll();
  }

  private loadAll() {
    const dir = this.dataDir!;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Project;
        this.projects.set(p.id, p);
      } catch (e) {
        console.warn(`[midiom] could not load ${f}:`, e);
      }
    }
    const state = this.readState();
    if (state.activeProjectId && this.projects.has(state.activeProjectId)) this.activeProjectId = state.activeProjectId;
  }

  private readState(): { activeProjectId?: string } {
    if (!this.dataDir) return {};
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, "..", "state.json"), "utf8"));
    } catch {
      return {};
    }
  }

  private writeState() {
    if (!this.dataDir) return;
    fs.writeFileSync(path.join(this.dataDir, "..", "state.json"), JSON.stringify({ activeProjectId: this.activeProjectId }));
  }

  private scheduleSave(p: Project) {
    if (!this.dataDir) return;
    clearTimeout(this.saveTimers.get(p.id));
    this.saveTimers.set(
      p.id,
      setTimeout(() => {
        this.saveTimers.delete(p.id);
        const current = this.projects.get(p.id);
        if (current) fs.writeFileSync(path.join(this.dataDir!, `${p.id}.json`), JSON.stringify(current));
      }, 300),
    );
  }

  flush() {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const p = this.projects.get(id);
      if (p && this.dataDir) fs.writeFileSync(path.join(this.dataDir, `${id}.json`), JSON.stringify(p));
    }
    this.saveTimers.clear();
  }

  // ---- Queries -------------------------------------------------------------

  list(): ProjectSummary[] {
    return [...this.projects.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        trackCount: p.tracks.length,
        noteCount: p.tracks.reduce((s, t) => s + t.notes.length, 0),
        updatedAt: p.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** Resolves a project id, defaulting to the one open in the editor. */
  resolve(id?: string | null): Project {
    const pid = id || this.activeProjectId;
    if (!pid) throw new Error("No project is open. Create one with create_project or open one with open_project.");
    const p = this.projects.get(pid);
    if (!p) throw new Error(`Project not found: ${pid}`);
    return p;
  }

  canUndo(id: string) {
    return (this.history.get(id)?.undo.length ?? 0) > 0;
  }
  canRedo(id: string) {
    return (this.history.get(id)?.redo.length ?? 0) > 0;
  }

  // ---- Mutations -----------------------------------------------------------

  add(project: Project, makeActive = true) {
    this.projects.set(project.id, project);
    this.scheduleSave(project);
    this.emit("projects", this.list());
    if (makeActive) this.setActive(project.id);
  }

  remove(id: string) {
    if (!this.projects.delete(id)) throw new Error(`Project not found: ${id}`);
    this.history.delete(id);
    if (this.dataDir) fs.rmSync(path.join(this.dataDir, `${id}.json`), { force: true });
    if (this.activeProjectId === id) this.setActive(null);
    this.emit("projects", this.list());
  }

  setActive(id: string | null) {
    if (id && !this.projects.has(id)) throw new Error(`Project not found: ${id}`);
    this.activeProjectId = id;
    this.selection = { projectId: id, noteIds: [] };
    this.writeState();
    this.emit("active", id);
    if (id) this.emit("project", this.projects.get(id)!);
  }

  /**
   * Applies `fn` to a working copy of the project. If it throws, nothing
   * changes. Otherwise the previous state goes on the undo stack.
   */
  mutate<T>(id: string | undefined | null, label: string, fn: (draft: Project) => T): { project: Project; result: T } {
    const current = this.resolve(id);
    const before = JSON.stringify(current);
    const draft = JSON.parse(before) as Project;
    const result = fn(draft);
    draft.version = current.version + 1;
    draft.updatedAt = new Date().toISOString();
    const h = this.history.get(draft.id) ?? { undo: [], redo: [], labels: { undo: [], redo: [] } };
    h.undo.push(before);
    h.labels.undo.push(label);
    if (h.undo.length > MAX_HISTORY) {
      h.undo.shift();
      h.labels.undo.shift();
    }
    h.redo = [];
    h.labels.redo = [];
    this.history.set(draft.id, h);
    this.commit(draft);
    return { project: draft, result };
  }

  undo(id?: string | null): string {
    const p = this.resolve(id);
    const h = this.history.get(p.id);
    if (!h || h.undo.length === 0) throw new Error("Nothing to undo.");
    const prev = JSON.parse(h.undo.pop()!) as Project;
    const label = h.labels.undo.pop()!;
    h.redo.push(JSON.stringify(p));
    h.labels.redo.push(label);
    prev.version = p.version + 1;
    this.commit(prev);
    return label;
  }

  redo(id?: string | null): string {
    const p = this.resolve(id);
    const h = this.history.get(p.id);
    if (!h || h.redo.length === 0) throw new Error("Nothing to redo.");
    const next = JSON.parse(h.redo.pop()!) as Project;
    const label = h.labels.redo.pop()!;
    h.undo.push(JSON.stringify(p));
    h.labels.undo.push(label);
    next.version = p.version + 1;
    this.commit(next);
    return label;
  }

  private commit(p: Project) {
    this.projects.set(p.id, p);
    this.scheduleSave(p);
    this.emit("project", p);
    this.emit("projects", this.list());
  }

  // ---- Ephemeral editor state ------------------------------------------------

  logActivity(e: Omit<ActivityEvent, "id" | "time">) {
    const event: ActivityEvent = { ...e, id: newId(), time: new Date().toISOString() };
    this.activity.push(event);
    if (this.activity.length > 100) this.activity.shift();
    this.emit("activity", event);
  }

  setSelection(sel: Selection) {
    this.selection = sel;
  }

  setPlayback(state: PlaybackState) {
    this.playback = state;
  }
}
