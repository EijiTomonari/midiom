import type { ActivityEvent, ClientMessage, Project, ProjectSummary, ServerMessage } from "../../shared/types";

export interface ClientState {
  connected: boolean;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  project: Project | null;
  canUndo: boolean;
  canRedo: boolean;
  activity: ActivityEvent[];
  error: string | null;
}

type PlaybackListener = (action: "play" | "pause" | "stop" | "seek", tick?: number) => void;
type SelectListener = (noteIds: string[]) => void;

/** Keeps a live mirror of the server's state over a WebSocket. */
export class MidiomClient {
  state: ClientState = { connected: false, projects: [], activeProjectId: null, project: null, canUndo: false, canRedo: false, activity: [], error: null };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;
  onPlayback: PlaybackListener | null = null;
  onSelect: SelectListener | null = null;

  constructor() {
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.set({ connected: true });
    ws.onclose = () => {
      this.set({ connected: false });
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case "hello":
        this.set({ projects: msg.projects, activeProjectId: msg.activeProjectId, activity: msg.activity, project: msg.activeProjectId ? this.state.project : null });
        break;
      case "projects":
        this.set({ projects: msg.projects });
        break;
      case "active":
        this.set({ activeProjectId: msg.projectId, project: msg.projectId && this.state.project?.id === msg.projectId ? this.state.project : null });
        break;
      case "project":
        if (msg.project.id === this.state.activeProjectId) this.set({ project: msg.project, canUndo: msg.canUndo, canRedo: msg.canRedo });
        break;
      case "activity":
        this.set({ activity: [...this.state.activity.slice(-49), msg.event] });
        break;
      case "playback":
        this.onPlayback?.(msg.action, msg.tick);
        break;
      case "select":
        this.onSelect?.(msg.noteIds);
        break;
      case "result":
        this.pending.get(msg.requestId)?.resolve(msg.result);
        this.pending.delete(msg.requestId);
        break;
      case "error":
        if (msg.requestId && this.pending.has(msg.requestId)) {
          this.pending.get(msg.requestId)!.reject(new Error(msg.message));
          this.pending.delete(msg.requestId);
        }
        this.set({ error: msg.message });
        setTimeout(() => this.state.error === msg.message && this.set({ error: null }), 4000);
        break;
    }
  }

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  command<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const requestId = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ type: "command", requestId, name, args });
    });
  }

  open(projectId: string) {
    this.send({ type: "open", projectId });
  }

  async importFile(file: File) {
    const res = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const body = await res.json();
    if (!res.ok) {
      this.set({ error: body.error });
      throw new Error(body.error);
    }
    return body.projectId as string;
  }
}

export const client = new MidiomClient();
