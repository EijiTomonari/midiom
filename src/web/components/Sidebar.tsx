import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, Project } from "../../shared/types";
import { GM_PROGRAMS } from "../../shared/music";
import { client } from "../lib/client";

interface Props {
  project: Project;
  activeTrackId: string | null;
  onActiveTrack: (id: string) => void;
  activity: ActivityEvent[];
}

export function Sidebar({ project, activeTrackId, onActiveTrack, activity }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const agentActivity = activity.filter((a) => a.source === "agent");
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [agentActivity.length]);

  return (
    <aside className="sidebar">
      <div className="section-head">
        <span>Tracks</span>
        <button className="ghost small" title="Add track" onClick={() => client.command("add_track", {}).then((r) => onActiveTrack(r.trackId))}>
          ＋
        </button>
      </div>
      <div className="tracks">
        {project.tracks.length === 0 && <div className="empty">No tracks yet.</div>}
        {project.tracks.map((t) => (
          <div key={t.id} className={`track ${t.id === activeTrackId ? "active" : ""}`} onClick={() => onActiveTrack(t.id)}>
            <span className="swatch" style={{ background: t.color }} />
            <div className="track-main">
              {editing === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.name}
                  onBlur={(e) => {
                    setEditing(null);
                    if (e.target.value && e.target.value !== t.name) client.command("update_track", { trackId: t.id, name: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <span className="track-name" onDoubleClick={() => setEditing(t.id)}>
                  {t.name}
                </span>
              )}
              <select
                className="track-inst"
                value={t.channel === 9 ? -1 : t.program}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v === -1) client.command("update_track", { trackId: t.id, channel: 9 });
                  else client.command("update_track", { trackId: t.id, program: v, ...(t.channel === 9 ? { channel: freeChannel(project) } : {}) });
                }}
              >
                <option value={-1}>Drum kit</option>
                {GM_PROGRAMS.map((name, i) => (
                  <option key={i} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="track-btns" onClick={(e) => e.stopPropagation()}>
              <button className={`toggle ${t.muted ? "on" : ""}`} title="Mute" onClick={() => client.command("update_track", { trackId: t.id, muted: !t.muted })}>
                M
              </button>
              <button className={`toggle solo ${t.solo ? "on" : ""}`} title="Solo" onClick={() => client.command("update_track", { trackId: t.id, solo: !t.solo })}>
                S
              </button>
              <button
                className="toggle"
                title="Delete track"
                onClick={() => confirm(`Delete track “${t.name}” and its ${t.notes.length} notes?`) && client.command("delete_track", { trackId: t.id })}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="section-head">
        <span>Agent activity</span>
      </div>
      <div className="activity" ref={feedRef}>
        {agentActivity.length === 0 && <div className="empty">When an agent edits this project, you'll see it here.</div>}
        {agentActivity.map((a) => (
          <div key={a.id} className={`activity-item ${a.ok ? "" : "failed"}`}>
            <span className="activity-tool">{a.tool}</span>
            <span>{a.summary}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function freeChannel(project: Project) {
  const used = new Set(project.tracks.map((t) => t.channel));
  for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
  return 0;
}
