import type { ParticlePhysics, ParticleType } from "../../shared/types";

// ---- Flow field ----------------------------------------------------------------------
// 3D gradient (Perlin) noise sampled in (x, y, time). Its curl gives a velocity
// field with no sources or sinks, so particles swirl and eddy like smoke instead
// of jittering randomly.

const PERM = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return Uint8Array.from([...p, ...p]);
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function grad(h: number, x: number, y: number, z: number) {
  const u = (h & 15) < 8 ? x : y;
  const v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(PERM[AA], x, y, z), grad(PERM[BA], x - 1, y, z), u), lerp(grad(PERM[AB], x, y - 1, z), grad(PERM[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad(PERM[AA + 1], x, y, z - 1), grad(PERM[BA + 1], x - 1, y, z - 1), u), lerp(grad(PERM[AB + 1], x, y - 1, z - 1), grad(PERM[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

/** Curl of the noise field at (x, y): a divergence-free swirl, roughly unit strength. */
function curl(x: number, y: number, t: number): [number, number] {
  const e = 0.01;
  const dx = (noise3(x + e, y, t) - noise3(x - e, y, t)) / (2 * e);
  const dy = (noise3(x, y + e, t) - noise3(x, y - e, t)) / (2 * e);
  return [dy, -dx];
}

// ---- Particle types -----------------------------------------------------------------------

type Shape = "spark" | "streak" | "glow" | "puff" | "star" | "ring";

interface TypeSpec {
  shape: Shape;
  /** Particles per second from each sounding note at amount = 1. */
  rate: number;
  /** Particles in the burst when a note starts, at amount = 1. */
  burst: number;
  /** Multiplier on the size slider. */
  scale: number;
}

const TYPES: Record<ParticleType, TypeSpec> = {
  sparks: { shape: "spark", rate: 90, burst: 24, scale: 1 },
  streaks: { shape: "streak", rate: 55, burst: 18, scale: 1 },
  embers: { shape: "glow", rate: 45, burst: 12, scale: 1.3 },
  smoke: { shape: "puff", rate: 22, burst: 6, scale: 3.2 },
  stars: { shape: "star", rate: 22, burst: 8, scale: 1.6 },
  bubbles: { shape: "ring", rate: 14, burst: 5, scale: 1.4 },
};

/** The physics sliders (0–1) mapped to real units. */
function units(p: ParticlePhysics) {
  return {
    speed: 20 + p.speed * 420, // px/s
    spreadAngle: p.spread * 1.3, // radians each side of straight up
    gravity: p.gravity * 600, // px/s², + is down
    turbulence: p.turbulence * p.turbulence * 1400, // px/s² (squared so low values stay gentle)
    swirlScale: 1 / (25 + p.swirlSize * 320), // noise frequency per px
    drag: p.drag * 4, // 1/s
    lifetime: 0.2 + p.lifetime * p.lifetime * 3.8, // s
    size: 0.6 + p.size * 7, // px
  };
}

interface Particle {
  x: number;
  y: number;
  px: number; // previous position, for streaks
  py: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  seed: number; // per-particle randomness for flicker, twinkle, wobble, rotation
}

const MAX = 3000;

export interface ParticleConfig {
  type: ParticleType;
  /** 0–1 */
  amount: number;
  physics: ParticlePhysics;
}

/** Particles that rise from notes as they hit the keyboard. */
export class Particles {
  private list: Particle[] = [];
  private carry = new Map<string, number>();
  private time = 0;
  private sprites = new Map<string, HTMLCanvasElement>();
  config: ParticleConfig = { type: "sparks", amount: 0.5, physics: { speed: 0.45, spread: 0.35, gravity: 0, turbulence: 0.2, swirlSize: 0.3, drag: 0.35, lifetime: 0.3, size: 0.15 } };

  /** Continuous emission from a sounding note. */
  stream(key: string, x: number, w: number, y: number, color: string, dt: number) {
    const spec = TYPES[this.config.type];
    const due = (this.carry.get(key) ?? 0) + spec.rate * this.config.amount * dt;
    const n = Math.floor(due);
    this.carry.set(key, due - n);
    for (let i = 0; i < n; i++) this.spawn(x + Math.random() * w, y, color, 1);
  }

  /** A burst when a note starts. */
  burst(x: number, w: number, y: number, color: string) {
    const count = Math.round(TYPES[this.config.type].burst * this.config.amount);
    for (let i = 0; i < count; i++) this.spawn(x + Math.random() * w, y, color, 1.6);
  }

  private spawn(x: number, y: number, color: string, energy: number) {
    if (this.list.length >= MAX) this.list.shift();
    const u = units(this.config.physics);
    const spec = TYPES[this.config.type];
    const angle = (Math.random() * 2 - 1) * u.spreadAngle;
    const speed = u.speed * energy * (0.45 + Math.random() * 0.75);
    const max = u.lifetime * (0.6 + Math.random() * 0.8);
    const py = y - Math.random() * 4;
    this.list.push({
      x,
      y: py,
      px: x,
      py,
      vx: Math.sin(angle) * speed,
      vy: -Math.cos(angle) * speed,
      life: max,
      max,
      size: u.size * spec.scale * (0.5 + Math.random()),
      color,
      seed: Math.random(),
    });
  }

  forget(activeKeys: Set<string>) {
    for (const k of this.carry.keys()) if (!activeKeys.has(k)) this.carry.delete(k);
  }

  update(dt: number, clipBottom: number) {
    this.time += dt;
    const u = units(this.config.physics);
    const isBubble = this.config.type === "bubbles";
    const damp = Math.exp(-u.drag * dt);
    const t = this.time * 0.35;
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0 || p.y > clipBottom + 30) continue;
      if (u.turbulence > 0) {
        const [cx, cy] = curl(p.x * u.swirlScale, p.y * u.swirlScale, t);
        p.vx += cx * u.turbulence * dt;
        p.vy += cy * u.turbulence * dt;
      }
      p.vy += u.gravity * dt;
      if (isBubble) p.vx += Math.sin(this.time * 6 + p.seed * 40) * 60 * dt; // wobble
      p.vx *= damp;
      p.vy *= damp;
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      keep.push(p);
    }
    this.list = keep;
  }

  /** A soft round glow (or a puff of mist), pre-rendered once per color. */
  private sprite(color: string, kind: "glow" | "puff" | "star"): HTMLCanvasElement {
    const key = `${kind}:${color}`;
    let c = this.sprites.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = color; // normalize any CSS color for the gradient
    if (kind === "star") {
      const glow = g.createRadialGradient(32, 32, 0, 32, 32, 18);
      glow.addColorStop(0, "rgba(255,255,255,0.9)");
      glow.addColorStop(0.35, color);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = glow;
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = i % 2 === 0 ? 31 : 4;
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(32, 32, 14, 0, Math.PI * 2);
      g.globalAlpha = 0.5;
      g.fill();
    } else {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      if (kind === "glow") {
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.2, color);
        grad.addColorStop(1, "rgba(0,0,0,0)");
      } else {
        grad.addColorStop(0, color);
        grad.addColorStop(1, "rgba(0,0,0,0)");
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    this.sprites.set(key, c);
    if (this.sprites.size > 200) this.sprites.delete(this.sprites.keys().next().value!);
    return c;
  }

  draw(ctx: CanvasRenderingContext2D, clipBottom: number, additive: boolean) {
    if (this.list.length === 0) return;
    const shape = TYPES[this.config.type].shape;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, clipBottom);
    ctx.clip();
    ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
    for (const p of this.list) {
      const t = p.life / p.max; // 1 at birth → 0 at death
      const fadeIn = Math.min(1, (1 - t) * 8);
      const alpha = Math.min(1, t * 1.4) * fadeIn;
      switch (shape) {
        case "spark":
          ctx.globalAlpha = alpha * 0.9;
          ctx.fillStyle = t > 0.75 ? "#ffffff" : p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        case "streak": {
          ctx.globalAlpha = alpha * 0.9;
          ctx.strokeStyle = t > 0.7 ? "#ffffff" : p.color;
          ctx.lineWidth = Math.max(0.6, p.size * 0.6);
          ctx.lineCap = "round";
          ctx.beginPath();
          // Trail length follows velocity, so fast streaks stretch.
          ctx.moveTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          break;
        }
        case "glow": {
          const flicker = 0.6 + 0.4 * Math.sin(this.time * 18 + p.seed * 60);
          const s = p.size * 3;
          ctx.globalAlpha = alpha * flicker;
          ctx.drawImage(this.sprite(p.color, "glow"), p.x - s / 2, p.y - s / 2, s, s);
          break;
        }
        case "puff": {
          const s = p.size * (2 + (1 - t) * 4); // mist spreads as it rises
          ctx.globalAlpha = alpha * 0.16;
          ctx.drawImage(this.sprite(p.color, "puff"), p.x - s / 2, p.y - s / 2, s, s);
          break;
        }
        case "star": {
          const twinkle = 0.5 + 0.5 * Math.sin(this.time * 9 + p.seed * 50);
          const s = p.size * 3 * (0.7 + 0.3 * twinkle);
          ctx.globalAlpha = alpha * (0.5 + 0.5 * twinkle);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.seed * Math.PI + this.time * (p.seed - 0.5));
          ctx.drawImage(this.sprite(p.color, "star"), -s / 2, -s / 2, s, s);
          ctx.restore();
          break;
        }
        case "ring": {
          const popping = t < 0.12;
          const r = p.size * (popping ? 1 + (0.12 - t) * 10 : 1);
          ctx.globalAlpha = alpha * (popping ? t / 0.12 : 0.85);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          // Highlight
          ctx.globalAlpha *= 0.8;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(p.x - r * 0.35, p.y - r * 0.35, Math.max(0.6, r * 0.18), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();
  }

  get count() {
    return this.list.length;
  }

  clear() {
    this.list = [];
    this.carry.clear();
  }
}
