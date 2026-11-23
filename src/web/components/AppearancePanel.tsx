import { useEffect, useRef } from "react";
import type { Appearance, Project } from "../../shared/types";
import { APPEARANCE_PRESETS } from "../../shared/music";
import { client } from "../lib/client";

interface Props {
  appearance: Appearance;
  project: Project;
  onChange: (patch: Partial<Appearance>) => void;
  onPreset: (preset: string) => void;
  onClose: () => void;
}

export function AppearancePanel({ appearance: a, project, onChange, onPreset, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pianoTracks = project.tracks.filter((t) => t.channel !== 9);

  return (
    <div className="popover look" ref={ref}>
      <div className="look-section">
        <div className="look-label">Presets</div>
        <div className="presets">
          {Object.entries(APPEARANCE_PRESETS).map(([key, p]) => (
            <button key={key} className="preset" onClick={() => onPreset(key)} title={`Apply “${p.label}”`}>
              <span className="preset-swatch" style={{ background: p.appearance.background ?? "#0e0f13" }}>
                <i style={{ background: p.appearance.handColors?.left ?? "#4ade80" }} />
                <i style={{ background: p.appearance.handColors?.right ?? "#60a5fa" }} />
              </span>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="look-section">
        <div className="look-label">Note colors</div>
        <Segmented value={a.colorBy} options={[["track", "By track"], ["hand", "By hand"]]} onChange={(v) => onChange({ colorBy: v })} />
        {a.colorBy === "hand" ? (
          <div className="color-rows">
            <ColorRow label="Left hand" value={a.handColors.left} onChange={(c) => onChange({ handColors: { ...a.handColors, left: c } })} />
            <ColorRow label="Right hand" value={a.handColors.right} onChange={(c) => onChange({ handColors: { ...a.handColors, right: c } })} />
            <ColorRow label="Unassigned" value={a.handColors.none} onChange={(c) => onChange({ handColors: { ...a.handColors, none: c } })} />
          </div>
        ) : (
          <div className="color-rows">
            {pianoTracks.length === 0 && <div className="muted">No tracks yet.</div>}
            {project.tracks.map((t) => (
              <ColorRow key={t.id} label={t.name} value={t.color} onChange={(c) => client.command("update_track", { trackId: t.id, color: c })} />
            ))}
          </div>
        )}
      </div>

      <div className="look-section">
        <div className="look-label">Note style</div>
        <Segmented value={a.noteStyle} options={[["solid", "Solid"], ["neon", "Neon"], ["glass", "Glass"]]} onChange={(v) => onChange({ noteStyle: v })} />
        <Toggle label="Note names" checked={a.noteLabels} onChange={(v) => onChange({ noteLabels: v })} />
      </div>

      <div className="look-section">
        <div className="look-label">Effects</div>
        <Slider label="Glow" value={a.glow} onChange={(v) => onChange({ glow: v })} />
        <Slider label="Particles" value={a.particles} onChange={(v) => onChange({ particles: v })} />
        <Toggle label="Light up keys" checked={a.litKeys} onChange={(v) => onChange({ litKeys: v })} />
      </div>

      <div className="look-section">
        <div className="look-label">Keyboard edge & background</div>
        <div className="color-rows">
          <ColorRow label="Key edge" value={a.keyEdgeColor} onChange={(c) => onChange({ keyEdgeColor: c })} />
          <ColorRow label="Background" value={a.background} onChange={(c) => onChange({ background: c })} />
        </div>
        <Toggle label="Edge flares in note colors" checked={a.keyEdgeFollowsNotes} onChange={(v) => onChange({ keyEdgeFollowsNotes: v })} />
      </div>
      <p className="muted look-tip">Tip: ask your agent — “make it look like a purple neon video”.</p>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented wide">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <label className="color-row">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span>{label}</span>
      <code>{value}</code>
    </label>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <code>{value === 0 ? "off" : `${Math.round(value * 100)}%`}</code>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
