import { useEffect, useRef } from "react";
import type { Appearance, Hand, Note, Project, Track } from "../../shared/types";
import { NOTE_NAMES, barLines, isBlackKey, pitchName } from "../../shared/music";
import { player } from "../lib/player";
import { rgba, shade, luminance } from "../lib/color";
import { Particles } from "../lib/particles";

const LOW = 21; // A0
const HIGH = 108; // C8
const KEYBOARD_H = 96;
/** Width of the sustain-pedal lane on the left. */
const GUTTER = 22;

export type Tool = "edit" | "left" | "right" | "erase";
const BRUSH_HAND: Record<Exclude<Tool, "edit">, Hand | null> = { left: "left", right: "right", erase: null };

interface Props {
  project: Project;
  selected: Set<string>;
  onSelect: (ids: Set<string>) => void;
  activeTrackId: string | null;
  grid: number; // beats
  viewRef: React.MutableRefObject<{ tick: number; pxPerBeat: number }>;
  onAddNote: (pitch: number, tick: number, durationTicks: number) => void;
  onCommitEdit: (updates: { id: string; pitch?: number; beat?: number; duration?: number }[]) => void;
  onSeek: (tick: number) => void;
  tool: Tool;
  /** Resolved look; colorBy is already forced to "hand" while a brush is active. */
  appearance: Appearance;
  onPaintHands: (noteIds: string[], hand: Hand | null) => void;
  onPedalEdit: (edit: PedalEdit) => void;
  /** Keep particles flowing while paused, so look changes can be seen. */
  previewParticles?: boolean;
}

export type PedalEdit =
  | { type: "add"; beat: number; duration: number }
  | { type: "update"; id: string; beat?: number; duration?: number }
  | { type: "delete"; id: string };

interface Drag {
  mode: "move" | "resize" | "box" | "paint" | "pedal-new" | "pedal-move" | "pedal-resize";
  pedalId?: string;
  startX: number;
  startY: number;
  originPitch: number;
  originTick: number;
  ids: string[];
  dTick: number;
  dPitch: number;
  moved: boolean;
  /** For box select. */
  x1?: number;
  y1?: number;
  additive?: boolean;
  /** For the hand brush. */
  painted?: Set<string>;
  brush?: Hand | null;
  lastX?: number;
  lastY?: number;
  /** Project version at commit; preview persists until a newer version arrives. */
  committedAt?: number;
}

// ---- Keyboard geometry ---------------------------------------------------------

function keyLayout(width: number) {
  let whites = 0;
  for (let p = LOW; p <= HIGH; p++) if (!isBlackKey(p)) whites++;
  const whiteW = (width - GUTTER) / whites;
  const blackW = whiteW * 0.62;
  const keys = new Map<number, { x: number; w: number; black: boolean }>();
  let wi = 0;
  for (let p = LOW; p <= HIGH; p++) {
    if (isBlackKey(p)) keys.set(p, { x: GUTTER + wi * whiteW - blackW / 2, w: blackW, black: true });
    else keys.set(p, { x: GUTTER + wi++ * whiteW, w: whiteW, black: false });
  }
  return { keys, whiteW, blackW };
}

function pitchAt(layout: ReturnType<typeof keyLayout>, x: number, preferBlack: boolean): number | null {
  if (preferBlack) {
    for (const [p, k] of layout.keys) if (k.black && x >= k.x && x < k.x + k.w) return p;
  }
  for (const [p, k] of layout.keys) if (!k.black && x >= k.x && x < k.x + k.w) return p;
  return null;
}

export function Roll({ project, selected, onSelect, activeTrackId, grid, viewRef, onAddNote, onCommitEdit, onSeek, tool, appearance, onPaintHands, onPedalEdit, previewParticles = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const pressedKey = useRef<number | null>(null);
  // Latest props for the render loop and event handlers.
  const props = useRef({ project, selected, activeTrackId, grid, tool, appearance, previewParticles });
  props.current = { project, selected, activeTrackId, grid, tool, appearance, previewParticles };
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Drop the optimistic drag preview once the server's update arrives.
  useEffect(() => {
    const d = drag.current;
    if (d?.committedAt !== undefined && project.version > d.committedAt) drag.current = null;
  }, [project.version]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let size = { w: 0, h: 0 };

    const resize = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size = { w: r.width, h: r.height };
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current!);
    resize();

    const particles = new Particles();
    let lastFrame = performance.now();
    let prevSounding = new Set<string>();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      const { project: p, selected: sel, activeTrackId: activeId, tool: currentTool, appearance: ap } = props.current;
      const byHand = ap.colorBy === "hand";
      const view = viewRef.current;
      if (player.playing) view.tick = player.tick;
      const { w, h } = size;
      if (!w) return;
      const hitY = h - KEYBOARD_H;
      const layout = keyLayout(w);
      const yOf = (tick: number) => hitY - ((tick - view.tick) / p.ppq) * view.pxPerBeat;
      const visibleTicks = (hitY / view.pxPerBeat) * p.ppq;
      const d = drag.current;
      const lightBg = luminance(ap.background) > 0.5;
      const ink = (a: number) => (lightBg ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`);
      const glow = ap.glow;

      // Background + lanes
      ctx.fillStyle = ap.background;
      ctx.fillRect(0, 0, w, h);
      for (const [pitch, k] of layout.keys) {
        if (k.black) {
          ctx.fillStyle = lightBg ? "rgba(0,0,0,0.035)" : "rgba(0,0,0,0.22)";
          ctx.fillRect(k.x, 0, k.w, hitY);
        } else if (pitch % 12 === 0 || pitch % 12 === 5) {
          ctx.fillStyle = ink(pitch % 12 === 0 ? 0.07 : 0.035);
          ctx.fillRect(k.x, 0, 1, hitY);
        }
      }

      // Bar & beat lines
      const lines = barLines(p, view.tick + visibleTicks + p.ppq * 8);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      for (const b of lines) {
        for (let i = 0; i < b.numerator; i++) {
          const y = yOf(b.tick + i * b.beatTicks);
          if (y < -20 || y > hitY) continue;
          ctx.fillStyle = ink(i === 0 ? 0.11 : 0.04);
          ctx.fillRect(0, Math.round(y), w, 1);
          if (i === 0) {
            ctx.fillStyle = ink(0.3);
            ctx.fillText(String(b.bar), GUTTER + 5, y - 4);
          }
        }
      }

      // Notes
      const sounding = new Map<number, { color: string; x: number; w: number; id: string }>();
      const anySolo = p.tracks.some((t) => t.solo);
      const labels: { text: string; x: number; y: number; w: number }[] = [];
      const drawTrack = (t: Track) => {
        const dim = t.muted || (anySolo && !t.solo);
        for (const n of t.notes) {
          let tick = n.tick, pitch = n.pitch, dur = n.duration;
          if (d && (d.mode === "move" || d.mode === "resize") && d.ids.includes(n.id)) {
            if (d.mode === "move") {
              tick = Math.max(0, tick + d.dTick);
              pitch = Math.min(HIGH, Math.max(LOW, pitch + d.dPitch));
            } else dur = Math.max(p.ppq / 16, dur + d.dTick);
          }
          if (tick > view.tick + visibleTicks || tick + dur < view.tick - p.ppq * 16) continue;
          const k = layout.keys.get(pitch);
          if (!k) continue;
          const hand = d?.mode === "paint" && d.painted!.has(n.id) ? d.brush ?? undefined : n.hand;
          const color = byHand ? (t.channel === 9 ? "#3f4350" : ap.handColors[hand ?? "none"]) : t.color;
          const isSounding = tick <= view.tick && tick + dur > view.tick && !dim;
          const x = k.x + 1, nw = k.w - 2;
          if (isSounding) sounding.set(pitch, { color, x, w: nw, id: n.id });
          const y0 = yOf(tick + dur);
          const y1 = yOf(tick);
          if (y1 < 0 || y0 > hitY) continue;
          const top = Math.max(y0, -4), bottom = Math.min(y1, hitY);
          const nh = Math.max(2, bottom - top);
          const radius = Math.min(5, nw / 3);
          const isSel = sel.has(n.id);
          const vel = 0.55 + (0.45 * n.velocity) / 127;
          const unassigned = byHand && !hand;

          ctx.save();
          if (glow > 0 && !dim) {
            ctx.shadowColor = color;
            ctx.shadowBlur = glow * (isSounding ? 28 : 14);
          }
          roundRect(ctx, x, top, nw, nh, radius);
          if (ap.noteStyle === "neon") {
            ctx.globalAlpha = dim ? 0.2 : 1;
            ctx.fillStyle = rgba(color, isSounding ? 0.35 : unassigned ? 0.06 : 0.12);
            ctx.fill();
            ctx.lineWidth = isSounding ? 2.5 : 1.8;
            ctx.strokeStyle = isSounding ? shade(color, 0.45) : color;
            ctx.globalAlpha = dim ? 0.25 : unassigned ? 0.6 : vel;
            ctx.stroke();
          } else if (ap.noteStyle === "glass") {
            const g = ctx.createLinearGradient(x, 0, x + nw, 0);
            g.addColorStop(0, shade(color, isSounding ? 0.55 : 0.35));
            g.addColorStop(0.45, isSounding ? shade(color, 0.2) : color);
            g.addColorStop(1, shade(color, -0.35));
            ctx.globalAlpha = dim ? 0.2 : unassigned ? 0.55 : vel;
            ctx.fillStyle = g;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.fillRect(x + nw * 0.18, top + 2, Math.max(1, nw * 0.12), Math.max(0, nh - 4));
          } else {
            ctx.globalAlpha = dim ? 0.18 : (unassigned ? 0.45 : 0.55) + (0.45 * n.velocity) / 127;
            ctx.fillStyle = isSounding ? shade(color, 0.3) : color;
            ctx.fill();
            if (k.black) {
              ctx.shadowBlur = 0;
              ctx.globalAlpha *= 0.35;
              ctx.fillStyle = "#000";
              ctx.fill();
            }
          }
          ctx.restore();
          if (isSel) {
            roundRect(ctx, x, top, nw, nh, radius);
            ctx.strokeStyle = lightBg ? "#111" : "#fff";
            ctx.lineWidth = 2;
            ctx.stroke();
          } else if (t.id === activeId && !dim && ap.noteStyle === "solid" && !byHand) {
            roundRect(ctx, x, top, nw, nh, radius);
            ctx.strokeStyle = "rgba(255,255,255,0.18)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          if (ap.noteLabels && nw >= 11 && nh >= 15) {
            labels.push({ text: NOTE_NAMES[pitch % 12], x: x + nw / 2, y: bottom - 5, w: nw });
          } else if (hand && !byHand && nw >= 9 && nh >= 16) {
            labels.push({ text: hand === "left" ? "L" : "R", x: x + nw / 2, y: bottom - 4, w: nw });
          }
        }
      };
      // Active track on top.
      for (const t of p.tracks) if (t.id !== activeId) drawTrack(t);
      const active = p.tracks.find((t) => t.id === activeId);
      if (active) drawTrack(active);

      // Note labels (drawn after all notes so they're never covered)
      if (labels.length) {
        ctx.save();
        ctx.textAlign = "center";
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 3;
        for (const l of labels) ctx.fillText(l.text, l.x, l.y, l.w);
        ctx.restore();
      }

      // Pressed key from the on-screen keyboard
      if (pressedKey.current !== null) {
        const k = layout.keys.get(pressedKey.current);
        if (k) sounding.set(pressedKey.current, { color: ap.keyEdgeColor, x: k.x + 1, w: k.w - 2, id: "pressed" });
      }

      // Particles
      particles.config = { type: ap.particleType, amount: ap.particles, physics: ap.particlePhysics };
      const active2 = new Set<string>();
      const previewing = props.current.previewParticles && !player.playing;
      if (ap.particles > 0 && (player.playing || pressedKey.current !== null || previewing)) {
        let emitters = [...sounding.values()];
        // Preview with nothing under the playhead: emit from a few spots along the keyboard.
        if (previewing && emitters.length === 0) {
          const colors = byHand ? [ap.handColors.left, ap.handColors.right] : p.tracks.map((t) => t.color).concat(ap.keyEdgeColor);
          emitters = [36, 52, 60, 67, 79].map((pitch, i) => {
            const k = layout.keys.get(pitch)!;
            return { color: colors[i % colors.length], x: k.x + 1, w: k.w - 2, id: `preview-${pitch}` };
          });
        }
        for (const s2 of emitters) {
          active2.add(s2.id);
          if (!prevSounding.has(s2.id) && !previewing) particles.burst(s2.x, s2.w, hitY, s2.color);
          particles.stream(s2.id, s2.x, s2.w, hitY, s2.color, dt);
        }
      }
      particles.forget(active2);
      prevSounding = active2;
      particles.update(dt, hitY);

      // Halo where notes meet the keys
      if (glow > 0) {
        ctx.save();
        ctx.globalCompositeOperation = lightBg ? "source-over" : "lighter";
        for (const s2 of sounding.values()) {
          const cx = s2.x + s2.w / 2;
          const r = 30 + 90 * glow;
          const g = ctx.createRadialGradient(cx, hitY, 0, cx, hitY, r);
          g.addColorStop(0, rgba(s2.color, 0.35 * glow));
          g.addColorStop(1, rgba(s2.color, 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, hitY - r, r * 2, r);
        }
        ctx.restore();
      }
      particles.draw(ctx, hitY, !lightBg);

      // Box selection
      if (d?.mode === "box" && d.x1 !== undefined && d.y1 !== undefined) {
        ctx.fillStyle = "rgba(96,165,250,0.12)";
        ctx.strokeStyle = "rgba(96,165,250,0.8)";
        ctx.lineWidth = 1;
        const bx = Math.min(d.startX, d.x1), by = Math.min(d.startY, d.y1);
        ctx.fillRect(bx, by, Math.abs(d.x1 - d.startX), Math.abs(d.y1 - d.startY));
        ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(d.x1 - d.startX), Math.abs(d.y1 - d.startY));
      }

      // Brush cursor / hover ghost
      const hv = hover.current;
      if (hv && currentTool !== "edit" && hv.y < hitY) {
        const brush = BRUSH_HAND[currentTool];
        ctx.beginPath();
        ctx.arc(hv.x, hv.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = brush ? ap.handColors[brush] : "#1b1d23";
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = brush ? "rgba(0,0,0,0.4)" : ap.handColors.none;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = brush ? "#0b1220" : "#c5c8d2";
        ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(brush === "left" ? "L" : brush === "right" ? "R" : "✕", hv.x - (brush ? 3 : 4), hv.y + 3.5);
      } else if (hv && !d && hv.y < hitY) {
        const pitch = pitchAt(layout, hv.x, hv.y < hitY);
        if (pitch !== null) {
          const k = layout.keys.get(pitch)!;
          ctx.fillStyle = ink(0.04);
          ctx.fillRect(k.x, 0, k.w, hitY);
          ctx.fillStyle = ink(0.5);
          ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(pitchName(pitch), Math.min(k.x + k.w + 4, w - 30), hv.y - 6);
        }
      }

      // Sustain-pedal lane (active track)
      const pedalTrack = p.tracks.find((t) => t.id === activeId) ?? p.tracks[0];
      ctx.fillStyle = lightBg ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.03)";
      ctx.fillRect(0, 0, GUTTER, h);
      ctx.fillStyle = ink(0.08);
      ctx.fillRect(GUTTER - 1, 0, 1, h);
      let pedalDown = false;
      for (const r of pedalTrack?.pedal ?? []) {
        let tick = r.tick, dur = r.duration;
        if (d?.pedalId === r.id && (d.mode === "pedal-move" || d.mode === "pedal-resize")) {
          if (d.mode === "pedal-move") tick = Math.max(0, tick + d.dTick);
          else dur = Math.max(p.ppq / 8, dur + d.dTick);
        }
        if (tick <= view.tick && tick + dur > view.tick) pedalDown = true;
        const y0 = yOf(tick + dur), y1 = yOf(tick);
        if (y1 < 0 || y0 > hitY) continue;
        const down = tick <= view.tick && tick + dur > view.tick;
        roundRect(ctx, 5, Math.max(-4, y0), GUTTER - 10, Math.max(3, Math.min(y1, hitY) - Math.max(-4, y0)), 3);
        ctx.fillStyle = rgba(ap.keyEdgeColor, down ? 0.9 : 0.5);
        ctx.fill();
        ctx.fillStyle = rgba(ap.keyEdgeColor, 1);
        ctx.fillRect(3, Math.min(y1, hitY) - 2, GUTTER - 6, 2); // the press
      }
      if (d?.mode === "pedal-new" && d.x1 !== undefined) {
        const ya = Math.min(d.startY, d.y1!), yb = Math.max(d.startY, d.y1!);
        ctx.fillStyle = rgba(ap.keyEdgeColor, 0.35);
        ctx.fillRect(5, ya, GUTTER - 10, yb - ya);
      }
      // Pedal light under the lane
      ctx.fillStyle = pedalDown ? rgba(ap.keyEdgeColor, 0.9) : ink(0.12);
      ctx.save();
      ctx.translate(GUTTER / 2 + 4, hitY + KEYBOARD_H / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("PED", 0, 0);
      ctx.restore();
      if (hv && hv.x < GUTTER && hv.y < hitY && !d) {
        ctx.fillStyle = ink(0.6);
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText("Sustain pedal — drag to add · double-click to remove", GUTTER + 6, hv.y + 4);
      }

      // Keyboard
      for (const black of [false, true]) {
        for (const [pitch, k] of layout.keys) {
          if (k.black !== black) continue;
          const lit = ap.litKeys ? sounding.get(pitch)?.color : undefined;
          const kh = black ? KEYBOARD_H * 0.62 : KEYBOARD_H;
          roundRect(ctx, k.x + (black ? 0 : 0.5), hitY, k.w - (black ? 0 : 1), kh, 3, true);
          if (lit) {
            const g = ctx.createLinearGradient(0, hitY, 0, hitY + kh);
            g.addColorStop(0, shade(lit, 0.15));
            g.addColorStop(1, black ? shade(lit, -0.3) : shade(lit, 0.55));
            ctx.save();
            if (glow > 0) {
              ctx.shadowColor = lit;
              ctx.shadowBlur = 16 * glow;
            }
            ctx.fillStyle = g;
            ctx.fill();
            ctx.restore();
          } else {
            ctx.fillStyle = black ? "#16171c" : "#e9eaee";
            ctx.fill();
          }
          if (!black && pitch % 12 === 0) {
            ctx.fillStyle = lit ? "rgba(0,0,0,0.6)" : "#9a9caa";
            ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
            ctx.fillText(`C${pitch / 12 - 1}`, k.x + 3, h - 6);
          }
        }
      }

      // Key edge (drawn last so its glow spills over the keys)
      ctx.save();
      const edgeGrad = ctx.createLinearGradient(0, hitY - 16, 0, hitY);
      edgeGrad.addColorStop(0, rgba(ap.keyEdgeColor, 0));
      edgeGrad.addColorStop(1, rgba(ap.keyEdgeColor, 0.12 + 0.2 * glow));
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, hitY - 16, w, 16);
      if (glow > 0) {
        ctx.shadowColor = ap.keyEdgeColor;
        ctx.shadowBlur = 12 * glow;
      }
      ctx.fillStyle = ap.keyEdgeColor;
      ctx.fillRect(0, hitY - 2, w, 3);
      if (ap.keyEdgeFollowsNotes) {
        for (const s2 of sounding.values()) {
          const cx = s2.x + s2.w / 2;
          const half = s2.w * 1.6;
          const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
          g.addColorStop(0, rgba(s2.color, 0));
          g.addColorStop(0.5, shade(s2.color, 0.6));
          g.addColorStop(1, rgba(s2.color, 0));
          ctx.shadowColor = s2.color;
          ctx.shadowBlur = 6 + 24 * glow;
          ctx.fillStyle = g;
          ctx.fillRect(cx - half, hitY - 3, half * 2, 4);
        }
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [viewRef]);

  // ---- Interaction ---------------------------------------------------------------

  const geometry = () => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return { r, hitY: r.height - KEYBOARD_H, layout: keyLayout(r.width) };
  };

  const tickAtY = (y: number, hitY: number) => {
    const { project: p } = props.current;
    return viewRef.current.tick + ((hitY - y) / viewRef.current.pxPerBeat) * p.ppq;
  };

  const noteAt = (x: number, y: number): { note: Note; track: Track; edge: boolean } | null => {
    const { project: p, activeTrackId: activeId } = props.current;
    const { hitY, layout } = geometry();
    const tick = tickAtY(y, hitY);
    const tracks = [...p.tracks].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0));
    for (const preferBlack of [true, false]) {
      for (const t of tracks) {
        for (const n of t.notes) {
          const k = layout.keys.get(n.pitch);
          if (!k || k.black !== preferBlack || x < k.x || x >= k.x + k.w) continue;
          if (tick >= n.tick && tick <= n.tick + n.duration) {
            const topY = hitY - ((n.tick + n.duration - viewRef.current.tick) / p.ppq) * viewRef.current.pxPerBeat;
            const bottomY = hitY - ((n.tick - viewRef.current.tick) / p.ppq) * viewRef.current.pxPerBeat;
            return { note: n, track: t, edge: y - topY < 6 && bottomY - topY > 10 };
          }
        }
      }
    }
    return null;
  };

  const pedalTrack = () => {
    const { project: p, activeTrackId: activeId } = props.current;
    return p.tracks.find((t) => t.id === activeId) ?? p.tracks[0];
  };

  const pedalAt = (y: number, hitY: number) => {
    const { project: p } = props.current;
    const tick = tickAtY(y, hitY);
    for (const range of pedalTrack()?.pedal ?? []) {
      if (tick >= range.tick && tick <= range.tick + range.duration) {
        const topY = hitY - ((range.tick + range.duration - viewRef.current.tick) / p.ppq) * viewRef.current.pxPerBeat;
        return { range, edge: y - topY < 6 };
      }
    }
    return null;
  };

  /** Adds every note under the brush to the current stroke. */
  const paintAt = (x: number, y: number) => {
    const d = drag.current;
    if (!d || d.mode !== "paint") return;
    const x0 = d.lastX ?? x, y0 = d.lastY ?? y;
    // Sample along the path so a fast stroke doesn't skip notes.
    const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / 3));
    for (let i = 0; i <= steps; i++) {
      const hit = noteAt(x0 + ((x - x0) * i) / steps, y0 + ((y - y0) * i) / steps);
      if (hit && hit.track.channel !== 9) d.painted!.add(hit.note.id);
    }
    d.lastX = x;
    d.lastY = y;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { r, hitY, layout } = geometry();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { project: p, selected: sel } = props.current;
    if (y >= hitY) {
      const pitch = pitchAt(layout, x, y < hitY + KEYBOARD_H * 0.62);
      if (pitch !== null) {
        const t = p.tracks.find((t) => t.id === props.current.activeTrackId);
        pressedKey.current = pitch;
        player.preview(pitch, t?.program ?? 0, t?.channel === 9);
      }
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    if (x < GUTTER) {
      const hit = pedalAt(y, hitY);
      const base = { startX: x, startY: y, x1: x, y1: y, originPitch: 0, ids: [], dTick: 0, dPitch: 0, moved: false };
      if (hit) drag.current = { ...base, mode: hit.edge ? "pedal-resize" : "pedal-move", pedalId: hit.range.id, originTick: hit.range.tick };
      else drag.current = { ...base, mode: "pedal-new", originTick: 0 };
      return;
    }
    const { tool: currentTool } = props.current;
    if (currentTool !== "edit") {
      drag.current = { mode: "paint", startX: x, startY: y, lastX: x, lastY: y, originPitch: 0, originTick: 0, ids: [], dTick: 0, dPitch: 0, moved: false, painted: new Set(), brush: BRUSH_HAND[currentTool] };
      paintAt(x, y);
      return;
    }
    const hit = noteAt(x, y);
    if (hit) {
      let ids: Set<string>;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        ids = new Set(sel);
        if (ids.has(hit.note.id)) ids.delete(hit.note.id);
        else ids.add(hit.note.id);
      } else ids = sel.has(hit.note.id) ? sel : new Set([hit.note.id]);
      onSelect(ids);
      player.preview(hit.note.pitch, hit.track.program, hit.track.channel === 9, hit.note.velocity);
      drag.current = {
        mode: hit.edge ? "resize" : "move",
        startX: x,
        startY: y,
        originPitch: hit.note.pitch,
        originTick: hit.note.tick,
        ids: [...ids],
        dTick: 0,
        dPitch: 0,
        moved: false,
      };
    } else {
      drag.current = { mode: "box", startX: x, startY: y, x1: x, y1: y, originPitch: 0, originTick: 0, ids: [], dTick: 0, dPitch: 0, moved: false, additive: e.shiftKey };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { r, hitY, layout } = geometry();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    hover.current = { x, y };
    const d = drag.current;
    if (d?.mode === "paint" && d.committedAt === undefined) {
      paintAt(x, y);
      return;
    }
    if ((!d || d.committedAt !== undefined) && x < GUTTER && y < hitY) {
      const hit = pedalAt(y, hitY);
      canvasRef.current!.style.cursor = hit ? (hit.edge ? "ns-resize" : "grab") : "copy";
      return;
    }
    if (!d || d.committedAt !== undefined) {
      if (props.current.tool !== "edit") {
        canvasRef.current!.style.cursor = y >= hitY ? "pointer" : "none";
        return;
      }
      const hit = y < hitY ? noteAt(x, y) : null;
      canvasRef.current!.style.cursor = hit ? (hit.edge ? "ns-resize" : "grab") : y >= hitY ? "pointer" : "crosshair";
      return;
    }
    const { project: p, grid } = props.current;
    if (Math.abs(x - d.startX) + Math.abs(y - d.startY) > 3) d.moved = true;
    const gridTicks = Math.max(1, Math.round(grid * p.ppq));
    if (d.mode === "pedal-new") {
      d.x1 = x;
      d.y1 = y;
      return;
    }
    if (d.mode === "pedal-move" || d.mode === "pedal-resize") {
      const raw = ((d.startY - y) / viewRef.current.pxPerBeat) * p.ppq;
      d.dTick = d.mode === "pedal-move" ? Math.round((d.originTick + raw) / gridTicks) * gridTicks - d.originTick : Math.round(raw / gridTicks) * gridTicks;
      return;
    }
    if (d.mode === "move") {
      const rawTick = d.originTick + ((d.startY - y) / viewRef.current.pxPerBeat) * p.ppq;
      d.dTick = Math.round(rawTick / gridTicks) * gridTicks - d.originTick;
      const pitch = pitchAt(layout, x, true);
      if (pitch !== null) d.dPitch = pitch - d.originPitch;
    } else if (d.mode === "resize") {
      d.dTick = Math.round(((d.startY - y) / viewRef.current.pxPerBeat) * p.ppq / gridTicks) * gridTicks;
    } else {
      d.x1 = x;
      d.y1 = y;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pressedKey.current = null;
    const d = drag.current;
    if (!d || d.committedAt !== undefined) return;
    const { project: p, selected: sel } = props.current;
    const { r, hitY, layout } = geometry();
    if (d.mode === "pedal-new" || d.mode === "pedal-move" || d.mode === "pedal-resize") {
      const gridTicks = Math.max(1, Math.round(props.current.grid * p.ppq));
      if (d.mode === "pedal-new") {
        drag.current = null;
        if (!d.moved) return;
        const a = tickAtY(Math.max(d.startY, d.y1!), hitY), b = tickAtY(Math.min(d.startY, d.y1!), hitY);
        const start = Math.max(0, Math.round(a / gridTicks) * gridTicks);
        const end = Math.max(start + gridTicks, Math.round(b / gridTicks) * gridTicks);
        onPedalEdit({ type: "add", beat: start / p.ppq, duration: (end - start) / p.ppq });
        return;
      }
      const range = pedalTrack()?.pedal?.find((r) => r.id === d.pedalId);
      if (!range || d.dTick === 0) {
        drag.current = null;
        return;
      }
      d.committedAt = p.version;
      if (d.mode === "pedal-move") onPedalEdit({ type: "update", id: range.id, beat: Math.max(0, range.tick + d.dTick) / p.ppq });
      else onPedalEdit({ type: "update", id: range.id, duration: Math.max(p.ppq / 8, range.duration + d.dTick) / p.ppq });
      setTimeout(() => drag.current === d && (drag.current = null), 1500);
      return;
    }
    if (d.mode === "paint") {
      const ids = [...d.painted!];
      if (ids.length === 0) {
        drag.current = null;
        return;
      }
      d.committedAt = p.version;
      onPaintHands(ids, d.brush ?? null);
      setTimeout(() => drag.current === d && (drag.current = null), 1500);
      return;
    }
    if (d.mode === "box") {
      drag.current = null;
      if (!d.moved) {
        if (!d.additive) onSelect(new Set());
        return;
      }
      const x0 = Math.min(d.startX, d.x1!), x1 = Math.max(d.startX, d.x1!);
      const t0 = tickAtY(Math.max(d.startY, d.y1!), hitY), t1 = tickAtY(Math.min(d.startY, d.y1!), hitY);
      const ids = new Set(d.additive ? sel : []);
      for (const t of p.tracks) {
        for (const n of t.notes) {
          const k = layout.keys.get(n.pitch);
          if (k && k.x + k.w > x0 && k.x < x1 && n.tick < t1 && n.tick + n.duration > t0) ids.add(n.id);
        }
      }
      onSelect(ids);
      return;
    }
    if (!d.moved || (d.dTick === 0 && d.dPitch === 0)) {
      drag.current = null;
      if (!d.moved && !(e.shiftKey || e.metaKey || e.ctrlKey)) {
        const hit = noteAt(e.clientX - r.left, e.clientY - r.top);
        if (hit) onSelect(new Set([hit.note.id]));
      }
      return;
    }
    const byId = new Map(p.tracks.flatMap((t) => t.notes.map((n) => [n.id, n] as const)));
    type Update = { id: string; pitch?: number; beat?: number; duration?: number };
    const updates = d.ids.flatMap((id): Update[] => {
      const n = byId.get(id);
      if (!n) return [];
      if (d.mode === "move") return [{ id, beat: Math.max(0, n.tick + d.dTick) / p.ppq, pitch: Math.min(HIGH, Math.max(LOW, n.pitch + d.dPitch)) }];
      return [{ id, duration: Math.max(p.ppq / 16, n.duration + d.dTick) / p.ppq }];
    });
    d.committedAt = p.version;
    onCommitEdit(updates);
    // Safety: drop the preview even if the server rejects the edit.
    setTimeout(() => drag.current === d && (drag.current = null), 1500);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { r, hitY, layout } = geometry();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < GUTTER) {
      const hit = y < hitY ? pedalAt(y, hitY) : null;
      if (hit) onPedalEdit({ type: "delete", id: hit.range.id });
      return;
    }
    if (y >= hitY || noteAt(x, y) || props.current.tool !== "edit") return;
    const { project: p, grid } = props.current;
    const pitch = pitchAt(layout, x, true);
    if (pitch === null) return;
    const gridTicks = Math.max(1, Math.round(grid * p.ppq));
    const tick = Math.max(0, Math.floor(tickAtY(y, hitY) / gridTicks) * gridTicks);
    onAddNote(pitch, tick, gridTicks);
  };

  // Native listener so ctrl/cmd+wheel zooms the roll instead of the page.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      const { project: p } = props.current;
      if (e.ctrlKey || e.metaKey) {
        view.pxPerBeat = Math.min(600, Math.max(12, view.pxPerBeat * Math.exp(-e.deltaY * 0.002)));
        return;
      }
      // Scrolling down moves forward in time (notes fall toward the keyboard).
      const next = Math.max(0, view.tick + (e.deltaY / view.pxPerBeat) * p.ppq);
      if (player.playing) onSeekRef.current(next);
      else view.tick = next;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [viewRef]);

  return (
    <div ref={wrapRef} className="roll">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (hover.current = null)}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, bottomOnly = false) {
  ctx.beginPath();
  if (bottomOnly) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.closePath();
    return;
  }
  ctx.roundRect(x, y, w, h, r);
}
