import { useRef, useState } from "react";
import type { ProjectSummary } from "../../shared/types";
import { client } from "../lib/client";

export function Welcome({ projects, onConnect }: { projects: ProjectSummary[]; onConnect: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const openFile = async (file?: File | null) => {
    if (file) await client.importFile(file).catch(() => {});
  };

  return (
    <div
      className={`welcome ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        openFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="welcome-inner">
        <h1>
          midi<span>om</span>
        </h1>
        <p className="tagline">A MIDI editor you can talk to.</p>
        <div className="welcome-actions">
          <button className="big" onClick={() => client.command("create_project", { name: "Untitled" })}>
            <span className="icon">＋</span>
            New project
          </button>
          <button className="big" onClick={() => fileRef.current?.click()}>
            <span className="icon">♫</span>
            Open MIDI file
          </button>
          <input ref={fileRef} type="file" accept=".mid,.midi,audio/midi" hidden onChange={(e) => openFile(e.target.files?.[0])} />
        </div>
        <p className="hint">…or drop a .mid file anywhere</p>

        {projects.length > 0 && (
          <div className="recent">
            <h2>Recent</h2>
            {projects.slice(0, 8).map((p) => (
              <div key={p.id} className="recent-item" onClick={() => client.open(p.id)}>
                <span className="recent-name">{p.name}</span>
                <span className="recent-meta">
                  {p.trackCount} track{p.trackCount === 1 ? "" : "s"} · {p.noteCount} notes · {timeAgo(p.updatedAt)}
                </span>
                <button
                  className="ghost small"
                  title="Delete project"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete “${p.name}”?`)) client.command("delete_project", { projectId: p.id });
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <button className="link" onClick={onConnect}>
          Connect Claude or another agent →
        </button>
        <p className="credit">
          Piano: <a href="https://archive.org/details/SalamanderGrandPianoV3" target="_blank" rel="noreferrer">Salamander Grand Piano</a> by Alexander Holm, CC BY 3.0
        </p>
      </div>
    </div>
  );
}

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
