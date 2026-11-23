import { useEffect, useRef } from "react";
import type { Appearance, ParticlePhysics, ParticleType, Project } from "../../shared/types";
import { APPEARANCE_PRESETS, PARTICLE_TYPES } from "../../shared/music";
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
        <Toggle label="Light up keys" checked={a.litKeys} onChange={(v) => onChange({ litKeys: v })} />
      </div>

      <div className="look-section">
        <div className="look-label">Particles</div>
        <Slider label="Amount" value={a.particles} onChange={(v) => onChange({ particles: v })} />
        <div className="particle-types">
          {(Object.keys(PARTICLE_TYPES) as ParticleType[]).map((type) => (
            <button
              key={type}
              className={a.particleType === type ? "on" : ""}
              title={PARTICLE_TYPES[type].description}
              onClick={() => onChange({ particleType: type, particlePhysics: { ...PARTICLE_TYPES[type].physics } })}
            >
              <span className="particle-icon">{PARTICLE_ICONS[type]}</span>
              {PARTICLE_TYPES[type].label}
            </button>
          ))}
        </div>
        {a.particles > 0 && (
          <>
            <div className="physics-head">
              <span>Physics</span>
              <button className="link" onClick={() => onChange({ particlePhysics: { ...PARTICLE_TYPES[a.particleType].physics } })}>
                Reset to {PARTICLE_TYPES[a.particleType].label.toLowerCase()} defaults
              </button>
            </div>
            {PHYSICS_SLIDERS.map((sl) => (
              <Slider
                key={sl.key}
                label={sl.label}
                title={sl.title}
                min={sl.min ?? 0}
                value={a.particlePhysics[sl.key]}
                format={sl.format}
                onChange={(v) => onChange({ particlePhysics: { ...a.particlePhysics, [sl.key]: v } })}
              />
            ))}
          </>
        )}
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

const PARTICLE_ICONS: Record<ParticleType, string> = { sparks: "✦", streaks: "☄", embers: "•", smoke: "☁", stars: "✧", bubbles: "○" };

const pct = (v: number) => (v === 0 ? "off" : `${Math.round(v * 100)}%`);
const PHYSICS_SLIDERS: { key: keyof ParticlePhysics; label: string; title: string; min?: number; format?: (v: number) => string }[] = [
  { key: "turbulence", label: "Turbulence", title: "Strength of the swirling flow that pushes particles around" },
  { key: "swirlSize", label: "Swirl size", title: "Small = tight jitter, large = big lazy eddies", format: (v) => (v < 0.34 ? "tight" : v < 0.67 ? "medium" : "wide") },
  { key: "speed", label: "Speed", title: "How fast particles shoot out" },
  { key: "spread", label: "Spread", title: "How widely they fan out from straight up" },
  {
    key: "gravity",
    label: "Gravity",
    title: "Left: particles float up. Right: they fall back down.",
    min: -1,
    format: (v) => (Math.abs(v) < 0.02 ? "none" : v < 0 ? `↑ ${Math.round(-v * 100)}%` : `↓ ${Math.round(v * 100)}%`),
  },
  { key: "drag", label: "Drag", title: "Air resistance: how quickly particles slow down" },
  { key: "lifetime", label: "Lifetime", title: "How long each particle lives", format: (v) => `${(0.2 + v * v * 3.8).toFixed(1)} s` },
  { key: "size", label: "Size", title: "Particle size", format: pct },
];

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

function Slider({ label, value, onChange, min = 0, format = pct, title }: { label: string; value: number; onChange: (v: number) => void; min?: number; format?: (v: number) => string; title?: string }) {
  return (
    <label className="slider-row" title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => min < 0 && onChange(0)}
      />
      <code>{format(value)}</code>
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
