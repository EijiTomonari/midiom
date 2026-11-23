/** Small color helpers for the canvas renderer. Accepts #rgb or #rrggbb. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Mix toward white (amt > 0) or black (amt < 0). */
export function shade(hex: string, amt: number): string {
  const [r, g, b] = parseHex(hex);
  const t = amt > 0 ? 255 : 0;
  const k = Math.abs(amt);
  const m = (c: number) => Math.round(c + (t - c) * k);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
