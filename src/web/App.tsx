import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Appearance, Hand, Project } from "../shared/types";
import { resolveAppearance, tickToBarBeat } from "../shared/music";
import { client } from "./lib/client";
import { player } from "./lib/player";
import { Roll, type PedalEdit, type Tool } from "./components/Roll";
import { Sidebar } from "./components/Sidebar";
import { Welcome } from "./components/Welcome";
import { ConnectDialog } from "./components/ConnectDialog";
import { AppearancePanel } from "./components/AppearancePanel";

const GRIDS = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
];

export function App() {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [showConnect, setShowConnect] = useState(false);

  return (
    <div className="app">
      {!state.connected && <div className="banner">Connecting to midiom server…</div>}
      {state.error && <div className="toast">{state.error}</div>}
      {state.project ? (
        <Editor project={state.project} canUndo={state.canUndo} canRedo={state.canRedo} activity={state.activity} onConnect={() => setShowConnect(true)} />
      ) : (
        <Welcome projects={state.projects} onConnect={() => setShowConnect(true)} />
      )}
      {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} />}
    </div>
  );
}

/** Merges appearance patches, including the nested color and physics groups. */
function mergeLook(base: Partial<Appearance>, patch: Partial<Appearance>): Partial<Appearance> {
  const out: Partial<Appearance> = { ...base, ...patch };
  if (base.handColors || patch.handColors) out.handColors = { ...base.handColors!, ...patch.handColors };
  if (base.particlePhysics || patch.particlePhysics) out.particlePhysics = { ...base.particlePhysics!, ...patch.particlePhysics };
  return out;
}

/** Turns an appearance patch into set_appearance arguments. */
function appearanceArgs(a: Partial<Appearance>): Record<string, unknown> {
  const { handColors, particlePhysics: ph, ...rest } = a;
  const args: Record<string, unknown> = { ...rest };
  if (handColors?.left) args.leftHandColor = handColors.left;
  if (handColors?.right) args.rightHandColor = handColors.right;
  if (handColors?.none) args.unassignedColor = handColors.none;
  if (ph) {
    const map = { speed: "particleSpeed", spread: "particleSpread", gravity: "particleGravity", turbulence: "turbulence", swirlSize: "swirlSize", drag: "particleDrag", lifetime: "particleLifetime", size: "particleSize" } as const;
    for (const [k, name] of Object.entries(map)) if (ph[k as keyof typeof map] !== undefined) args[name] = ph[k as keyof typeof map];
  }
  return args;
}

function Editor({ project, canUndo, canRedo, activity, onConnect }: { project: Project; canUndo: boolean; canRedo: boolean; activity: import("../shared/types").ActivityEvent[]; onConnect: () => void }) {
  const [selected, setSelectedState] = useState<Set<string>>(new Set());
  const [activeTrackId, setActiveTrackId] = useState<string | null>(project.tracks[0]?.id ?? null);
  const [grid, setGrid] = useState(0.25);
  const [tool, setTool] = useState<Tool>("edit");
  const [pianoLoad, setPianoLoad] = useState(player.loadProgress);
  useEffect(() => {
    player.onLoadProgress = setPianoLoad;
    player.init();
  }, []);
  const [showLook, setShowLook] = useState(false);
  // Appearance edits apply instantly here and are sent to the server debounced.
  const [lookOverride, setLookOverride] = useState<Partial<Appearance>>({});
  const lookTimer = useRef<number | null>(null);
  const lookPending = useRef<Partial<Appearance>>({});
  const saved = resolveAppearance(project);
  const look = mergeLook(saved, lookOverride) as Appearance;
  const colorByHand = look.colorBy === "hand" || tool !== "edit";
  const setLook = useCallback((patch: Partial<Appearance>) => {
    setLookOverride((o) => mergeLook(o, patch));
    lookPending.current = mergeLook(lookPending.current, patch);
    if (lookTimer.current) clearTimeout(lookTimer.current);
    lookTimer.current = window.setTimeout(() => {
      const a = lookPending.current;
      lookPending.current = {};
      client.command("set_appearance", appearanceArgs(a)).finally(() => {
        // The server's copy is current now; drop overrides unless more edits are queued.
        if (Object.keys(lookPending.current).length === 0) setLookOverride({});
      });
    }, 150);
  }, []);
  const applyPreset = (preset: string) => {
    lookPending.current = {};
    if (lookTimer.current) clearTimeout(lookTimer.current);
    setLookOverride({});
    client.command("set_appearance", { preset });
  };
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState("1.1");
  const viewRef = useRef({ tick: 0, pxPerBeat: 80 });
  const fileRef = useRef<HTMLInputElement>(null);

  const setSelected = useCallback((ids: Set<string>) => {
    setSelectedState(ids);
    client.send({ type: "selection", noteIds: [...ids] });
  }, []);

  // Keep the player and the active track in sync with the project.
  useEffect(() => {
    player.setProject(project);
    player.refresh();
    if (!project.tracks.some((t) => t.id === activeTrackId)) setActiveTrackId(project.tracks[0]?.id ?? null);
    const ids = new Set(project.tracks.flatMap((t) => t.notes.map((n) => n.id)));
    setSelectedState((sel) => {
      const next = new Set([...sel].filter((id) => ids.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [project]);

  useEffect(() => {
    viewRef.current.tick = 0;
    setSelectedState(new Set());
  }, [project.id]);

  // Transport
  const play = useCallback((fromTick?: number) => {
    player.play(fromTick ?? viewRef.current.tick);
    setPlaying(true);
    client.send({ type: "playback", playing: true, tick: player.tick });
  }, []);
  const pause = useCallback(() => {
    player.pause();
    setPlaying(false);
    client.send({ type: "playback", playing: false, tick: player.tick });
  }, []);
  const toggle = useCallback(() => (player.playing ? pause() : play()), [play, pause]);
  const seek = useCallback((tick: number) => {
    viewRef.current.tick = tick;
    player.seek(tick);
  }, []);

  useEffect(() => {
    player.onEnd = () => {
      setPlaying(false);
      viewRef.current.tick = 0;
    };
    client.onPlayback = (action, tick) => {
      if (action === "play") play(tick);
      else if (action === "pause") pause();
      else if (action === "stop") {
        pause();
        seek(0);
      } else if (action === "seek" && tick !== undefined) seek(tick);
    };
    client.onSelect = (ids) => setSelectedState(new Set(ids));
  }, [play, pause, seek]);

  // Position readout + periodic playhead report for the agent.
  useEffect(() => {
    let last = "";
    const id = setInterval(() => {
      const { bar, beat } = tickToBarBeat(project, viewRef.current.tick);
      const label = `${bar}.${Math.floor(beat)}`;
      if (label !== last) {
        last = label;
        setPosition(label);
        client.send({ type: "playback", playing: player.playing, tick: viewRef.current.tick });
      }
    }, 100);
    return () => clearInterval(id);
  }, [project]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      const mod = e.metaKey || e.ctrlKey;
      const ids = [...selected];
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        client.command(e.shiftKey ? "redo" : "undo").catch(() => {});
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        client.command("redo").catch(() => {});
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(project.tracks.flatMap((t) => (activeTrackId && t.id !== activeTrackId ? [] : t.notes.map((n) => n.id)))));
      } else if ((e.key === "Delete" || e.key === "Backspace") && ids.length) {
        e.preventDefault();
        client.command("delete_notes", { noteIds: ids });
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && ids.length) {
        e.preventDefault();
        const st = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
        client.command("transform_notes", { noteIds: ids, transpose: st }).catch(() => {});
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && ids.length) {
        e.preventDefault();
        client.command("transform_notes", { noteIds: ids, shiftBeats: (e.key === "ArrowRight" ? 1 : -1) * grid }).catch(() => {});
      } else if (e.key.toLowerCase() === "q" && ids.length) {
        client.command("quantize_notes", { noteIds: ids, grid });
      } else if (mod && e.key.toLowerCase() === "d" && ids.length) {
        e.preventDefault();
        client.command("copy_notes", { noteIds: ids }).then((r) => setSelected(new Set(r.noteIds)));
      } else if (!mod && ["l", "r", "e"].includes(e.key.toLowerCase())) {
        const key = e.key.toLowerCase();
        if (e.shiftKey && ids.length && key !== "e") {
          // Shift+L / Shift+R marks the selection.
          client.command("set_hand", { noteIds: ids, setTo: key === "l" ? "left" : "right" });
        } else if (!e.shiftKey) {
          const next: Tool = key === "l" ? "left" : key === "r" ? "right" : "erase";
          setTool((t) => (t === next ? "edit" : next));
        }
      } else if (e.key.toLowerCase() === "v" && !mod) {
        setTool("edit");
      } else if (e.key === "Escape") {
        setTool("edit");
        setSelected(new Set());
      } else if (e.key === "Home" || e.key === "Enter") {
        seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, project, activeTrackId, grid, toggle, seek, setSelected]);

  const addNote = async (pitch: number, tick: number, duration: number) => {
    let trackId = activeTrackId;
    if (!trackId) {
      const r = await client.command("add_track", { name: "Piano" });
      trackId = r.trackId;
      setActiveTrackId(trackId);
    }
    const r = await client.command("add_notes", { trackId, notes: [{ pitch, beat: tick / project.ppq, duration: duration / project.ppq }] });
    setSelected(new Set(r.noteIds));
  };

  const editPedal = (edit: PedalEdit) => {
    const trackId = activeTrackId ?? project.tracks[0]?.id;
    if (!trackId) return;
    const cmd = edit.type === "add" ? ["add_pedal", { trackId, ranges: [{ beat: edit.beat, duration: edit.duration }] }] : edit.type === "update" ? ["update_pedal", { trackId, id: edit.id, beat: edit.beat, duration: edit.duration }] : ["delete_pedal", { trackId, ids: [edit.id] }];
    client.command(cmd[0] as string, cmd[1] as Record<string, unknown>).catch(() => {});
  };

  const paintHands = (noteIds: string[], hand: Hand | null) => {
    const byId = new Map(project.tracks.flatMap((t) => t.notes.map((n) => [n.id, n] as const)));
    const changed = noteIds.filter((id) => (byId.get(id)?.hand ?? null) !== hand);
    if (changed.length) client.command("set_hand", { noteIds: changed, setTo: hand }).catch(() => {});
  };
  const hasHandParts = project.tracks.some((t) => t.channel !== 9);

  const bpm = project.tempos[0]?.bpm ?? 120;
  const ts = project.timeSignatures[0];

  return (
    <div className="editor">
      <header className="topbar">
        <button className="ghost logo" title="All projects" onClick={() => { pause(); client.send({ type: "open", projectId: "" }); }}>
          midi<span>om</span>
        </button>
        <input
          className="project-name"
          key={project.id + project.name}
          defaultValue={project.name}
          onBlur={(e) => e.target.value !== project.name && client.command("update_project", { name: e.target.value || "Untitled" })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />

        <div className="transport">
          <button className="ghost" title="Back to start (Home)" onClick={() => seek(0)}>⏮</button>
          <button className="play" title="Play / pause (Space)" onClick={toggle}>{playing ? "❚❚" : "▶"}</button>
          <span className="position" title="Bar.beat">{position}</span>
          <label className="field" title="Tempo (BPM)">
            <input
              key={`bpm-${bpm}`}
              type="number"
              min={10}
              max={400}
              defaultValue={Math.round(bpm * 100) / 100}
              onBlur={(e) => Number(e.target.value) !== bpm && client.command("set_tempo", { bpm: Number(e.target.value) })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <span>bpm</span>
          </label>
          <span className="meter">{ts ? `${ts.numerator}/${ts.denominator}` : "4/4"}</span>
        </div>

        <div className="tools">
          <label className="field" title="Snap grid">
            <span>grid</span>
            <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
              {GRIDS.map((g) => <option key={g.label} value={g.beats}>{g.label}</option>)}
            </select>
          </label>
          <button className="ghost" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => client.command("undo")}>↶</button>
          <button className="ghost" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => client.command("redo")}>↷</button>
          <button className="ghost" title="Open MIDI file as a new project" onClick={() => fileRef.current?.click()}>Open</button>
          <input ref={fileRef} type="file" accept=".mid,.midi,audio/midi" hidden onChange={(e) => e.target.files?.[0] && client.importFile(e.target.files[0])} />
          <a className="button ghost" href={`/api/projects/${project.id}/midi`} title="Download as .mid">Export</a>
          <div className="popover-anchor">
            <button className={`ghost ${showLook ? "active" : ""}`} title="Colors, glow, particles…" onClick={() => setShowLook((v) => !v)}>Look</button>
            {showLook && <AppearancePanel appearance={look} project={project} onChange={setLook} onPreset={applyPreset} onClose={() => setShowLook(false)} />}
          </div>
          <button className="agent-btn" onClick={onConnect}>✦ Agent</button>
        </div>
      </header>

      <div className="workspace">
        <Sidebar project={project} activeTrackId={activeTrackId} onActiveTrack={setActiveTrackId} activity={activity} />
        <div className="stage">
          {hasHandParts && (
            <div className="segmented palette" role="group" aria-label="Hands">
              <button className={tool === "edit" ? "on" : ""} title="Edit notes (V)" onClick={() => setTool("edit")}>✎</button>
              <button className={`hand-l ${tool === "left" ? "on" : ""}`} title="Left-hand brush (L) — drag across notes" onClick={() => setTool(tool === "left" ? "edit" : "left")}>L</button>
              <button className={`hand-r ${tool === "right" ? "on" : ""}`} title="Right-hand brush (R) — drag across notes" onClick={() => setTool(tool === "right" ? "edit" : "right")}>R</button>
              <button className={tool === "erase" ? "on" : ""} title="Clear hand (E)" onClick={() => setTool(tool === "erase" ? "edit" : "erase")}>⌀</button>
              <button title="Guess hands for unmarked notes" onClick={() => client.command("auto_assign_hands", selected.size ? { noteIds: [...selected] } : {}).then(() => setLook({ colorBy: "hand" })).catch(() => {})}>Auto</button>
              <button className={colorByHand ? "on" : ""} disabled={tool !== "edit"} title="Color notes by hand instead of by track" onClick={() => setLook({ colorBy: look.colorBy === "hand" ? "track" : "hand" })}>Colors</button>
          <button
            title="Write sustain pedal for the selected track: re-pedal at every chord change"
            onClick={() => activeTrackId && client.command("auto_pedal", { trackId: activeTrackId }).catch(() => {})}
          >
            Auto pedal
          </button>
            </div>
          )}
          <Roll
            project={project}
            selected={selected}
            onSelect={setSelected}
            activeTrackId={activeTrackId}
            grid={grid}
            viewRef={viewRef}
            onAddNote={addNote}
            onCommitEdit={(updates) => client.command("update_notes", { updates }).catch(() => {})}
            onSeek={seek}
            tool={tool}
            appearance={colorByHand ? { ...look, colorBy: "hand" } : look}
            onPaintHands={paintHands}
            onPedalEdit={editPedal}
            previewParticles={showLook}
          />
        </div>
      </div>
      <footer className="statusbar">
        {pianoLoad < 1 && <span className="loading">Loading piano {Math.round(pianoLoad * 100)}%</span>}
        <span>{tool !== "edit" ? `${tool === "erase" ? "Clear-hand" : tool === "left" ? "Left-hand" : "Right-hand"} brush — drag across notes to paint them · L / R / E switch brush · Esc or V back to editing` : selected.size ? `${selected.size} selected — ↑↓ transpose · ←→ move · Q quantize · ⌘D duplicate · ⇧L/⇧R mark hand · ⌫ delete` : "Double-click to add a note · drag to move · drag a note's top edge to resize · scroll to move through time · ⌘/ctrl+scroll to zoom"}</span>
      </footer>
    </div>
  );
}
