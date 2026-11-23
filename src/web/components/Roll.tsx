import { useEffect, useRef } from "react";
import type { Note, Project, Track } from "../../shared/types";
import { barLines, isBlackKey, pitchName } from "../../shared/music";
import { player } from "../lib/player";

const LOW = 21; // A0
const HIGH = 108; // C8
const KEYBOARD_H = 96;
const GUTTER = 0;

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
}

interface Drag {
  mode: "move" | "resize" | "box";
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

export function Roll({ project, selected, onSelect, activeTrackId, grid, viewRef, onAddNote, onCommitEdit, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const pressedKey = useRef<number | null>(null);
  // Latest props for the render loop and event handlers.
  const props = useRef({ project, selected, activeTrackId, grid });
  props.current = { project, selected, activeTrackId, grid };
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

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { project: p, selected: sel, activeTrackId: activeId } = props.current;
      const view = viewRef.current;
      if (player.playing) view.tick = player.tick;
      const { w, h } = size;
      if (!w) return;
      const hitY = h - KEYBOARD_H;
      const layout = keyLayout(w);
      const yOf = (tick: number) => hitY - ((tick - view.tick) / p.ppq) * view.pxPerBeat;
      const visibleTicks = (hitY / view.pxPerBeat) * p.ppq;
      const d = drag.current;

      // Background + lanes
      ctx.fillStyle = "#0e0f13";
      ctx.fillRect(0, 0, w, h);
      for (const [pitch, k] of layout.keys) {
        if (k.black) {
          ctx.fillStyle = "#121318";
          ctx.fillRect(k.x, 0, k.w, hitY);
        } else if (pitch % 12 === 0 || pitch % 12 === 5) {
          ctx.fillStyle = pitch % 12 === 0 ? "#22242c" : "#191a20";
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
          ctx.fillStyle = i === 0 ? "#2c2f3a" : "#1a1c23";
          ctx.fillRect(0, Math.round(y), w, 1);
          if (i === 0) {
            ctx.fillStyle = "#5b6070";
            ctx.fillText(String(b.bar), 6, y - 4);
          }
        }
      }

      // Notes
      const sounding = new Map<number, string>();
      const anySolo = p.tracks.some((t) => t.solo);
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
          const y0 = yOf(tick + dur);
          const y1 = yOf(tick);
          if (y1 < 0 || y0 > hitY) {
            if (tick <= view.tick && tick + dur > view.tick && !dim) sounding.set(pitch, t.color);
            continue;
          }
          const isSel = sel.has(n.id);
          ctx.globalAlpha = dim ? 0.18 : 0.55 + (0.45 * n.velocity) / 127;
          ctx.fillStyle = t.color;
          const x = k.x + 1, nw = k.w - 2;
          const top = Math.max(y0, -4), bottom = Math.min(y1, hitY);
          roundRect(ctx, x, top, nw, Math.max(2, bottom - top), Math.min(4, nw / 3));
          ctx.fill();
          if (k.black) {
            ctx.globalAlpha *= 0.35;
            ctx.fillStyle = "#000";
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          if (isSel) {
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.stroke();
          } else if (t.id === activeId && !dim) {
            ctx.strokeStyle = "rgba(255,255,255,0.18)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          if (tick <= view.tick && tick + dur > view.tick && !dim) sounding.set(pitch, t.color);
        }
      };
      // Active track on top.
      for (const t of p.tracks) if (t.id !== activeId) drawTrack(t);
      const active = p.tracks.find((t) => t.id === activeId);
      if (active) drawTrack(active);

      // Box selection
      if (d?.mode === "box" && d.x1 !== undefined && d.y1 !== undefined) {
        ctx.fillStyle = "rgba(96,165,250,0.12)";
        ctx.strokeStyle = "rgba(96,165,250,0.8)";
        ctx.lineWidth = 1;
        const bx = Math.min(d.startX, d.x1), by = Math.min(d.startY, d.y1);
        ctx.fillRect(bx, by, Math.abs(d.x1 - d.startX), Math.abs(d.y1 - d.startY));
        ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(d.x1 - d.startX), Math.abs(d.y1 - d.startY));
      }

      // Hover ghost (where a double-click would add a note)
      const hv = hover.current;
      if (hv && !d && hv.y < hitY) {
        const pitch = pitchAt(layout, hv.x, hv.y < hitY);
        if (pitch !== null) {
          const k = layout.keys.get(pitch)!;
          ctx.fillStyle = "rgba(255,255,255,0.04)";
          ctx.fillRect(k.x, 0, k.w, hitY);
          ctx.fillStyle = "#8b90a0";
          ctx.fillText(pitchName(pitch), Math.min(k.x + k.w + 4, w - 30), hv.y - 6);
        }
      }

      // Hit line
      const grad = ctx.createLinearGradient(0, hitY - 18, 0, hitY);
      grad.addColorStop(0, "rgba(96,165,250,0)");
      grad.addColorStop(1, "rgba(96,165,250,0.18)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, hitY - 18, w, 18);
      ctx.fillStyle = "#60a5fa";
      ctx.fillRect(0, hitY - 2, w, 2);

      // Keyboard
      if (pressedKey.current !== null) sounding.set(pressedKey.current, "#94a3b8");
      for (const black of [false, true]) {
        for (const [pitch, k] of layout.keys) {
          if (k.black !== black) continue;
          const lit = sounding.get(pitch);
          const kh = black ? KEYBOARD_H * 0.62 : KEYBOARD_H;
          ctx.fillStyle = lit ?? (black ? "#16171c" : "#e9eaee");
          roundRect(ctx, k.x + (black ? 0 : 0.5), hitY, k.w - (black ? 0 : 1), kh, 3, true);
          ctx.fill();
          if (!black && pitch % 12 === 0) {
            ctx.fillStyle = lit ? "#111" : "#9a9caa";
            ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
            ctx.fillText(`C${pitch / 12 - 1}`, k.x + 3, h - 6);
          }
        }
      }
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
    if (!d || d.committedAt !== undefined) {
      const hit = y < hitY ? noteAt(x, y) : null;
      canvasRef.current!.style.cursor = hit ? (hit.edge ? "ns-resize" : "grab") : y >= hitY ? "pointer" : "crosshair";
      return;
    }
    const { project: p, grid } = props.current;
    if (Math.abs(x - d.startX) + Math.abs(y - d.startY) > 3) d.moved = true;
    const gridTicks = Math.max(1, Math.round(grid * p.ppq));
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
    if (y >= hitY || noteAt(x, y)) return;
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
