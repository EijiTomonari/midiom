interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

const MAX = 3000;

/** Sparks that rise from notes as they hit the keyboard. */
export class Particles {
  private list: Particle[] = [];
  private carry = new Map<string, number>();

  /** Continuous emission from a sounding note: `rate` particles per second. */
  stream(key: string, x: number, w: number, y: number, color: string, rate: number, dt: number) {
    const due = (this.carry.get(key) ?? 0) + rate * dt;
    const n = Math.floor(due);
    this.carry.set(key, due - n);
    for (let i = 0; i < n; i++) this.spawn(x + Math.random() * w, y, color, 1);
  }

  /** A burst when a note starts. */
  burst(x: number, w: number, y: number, color: string, count: number) {
    for (let i = 0; i < count; i++) this.spawn(x + Math.random() * w, y, color, 1.8);
  }

  private spawn(x: number, y: number, color: string, energy: number) {
    if (this.list.length >= MAX) this.list.shift();
    const max = 0.5 + Math.random() * 1.1;
    this.list.push({
      x,
      y: y - Math.random() * 4,
      vx: (Math.random() - 0.5) * 50 * energy,
      vy: -(50 + Math.random() * 150) * energy,
      life: max,
      max,
      size: 0.6 + Math.random() * 1.8,
      color,
    });
  }

  forget(activeKeys: Set<string>) {
    for (const k of this.carry.keys()) if (!activeKeys.has(k)) this.carry.delete(k);
  }

  update(dt: number) {
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      // Drift upward, slow down, and wander like embers.
      p.vx = p.vx * (1 - 1.5 * dt) + (Math.random() - 0.5) * 120 * dt;
      p.vy = p.vy * (1 - 0.8 * dt) - 20 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      keep.push(p);
    }
    this.list = keep;
  }

  draw(ctx: CanvasRenderingContext2D, clipBottom: number) {
    if (this.list.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.list) {
      if (p.y > clipBottom) continue;
      const t = p.life / p.max;
      ctx.globalAlpha = Math.min(1, t * 1.4) * 0.9;
      ctx.fillStyle = t > 0.75 ? "#ffffff" : p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
  }

  clear() {
    this.list = [];
    this.carry.clear();
  }
}
