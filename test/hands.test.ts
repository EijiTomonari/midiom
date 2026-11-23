import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app";
import { assignHands } from "../src/server/analysis";
import { handFromTrackName } from "../src/server/midi-io";
import type { Note } from "../src/shared/types";

let app: ReturnType<typeof createApp>;
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  if (res.isError) throw new Error(res.content[0].text);
  try { return JSON.parse(res.content[0].text); } catch { return res.content[0].text; }
};

beforeAll(async () => {
  app = createApp({ dataDir: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`)));
});
afterAll(async () => {
  await client.close();
  app.server.close();
});

// One piano track: left hand holds C – Am – F – G, right hand plays a melody
// full of passing tones (D over C, B over Am, G over F, E over G…).
const LEFT = [["C3", "E3", "G3"], ["A2", "C3", "E3"], ["F2", "A2", "C3"], ["G2", "B2", "D3"]];
const RIGHT = [["E5", "D5", "C5", "D5"], ["E5", "B4", "C5", "B4"], ["A4", "G4", "A4", "G4"], ["E5", "D5", "E5", "F5"]];
const pianoPart = () => [
  ...LEFT.flatMap((c, bar) => c.map((pitch) => ({ pitch, beat: bar * 4, duration: 4 }))),
  ...RIGHT.flatMap((m, bar) => m.map((pitch, i) => ({ pitch, beat: bar * 4 + i, duration: 1 }))),
];
const chordNames = (h: { chords: { chord: string }[] }) => h.chords.map((c) => c.chord);

describe("hands", () => {
  it("auto-assigns hands and improves chord detection", async () => {
    await call("create_project", { name: "Piano piece" });
    await call("add_notes", { notes: pianoPart() });

    const before = await call("analyze_harmony", { resolution: "bar" });
    expect(before.weightedByHand).toBe(false);
    expect(chordNames(before)).not.toEqual(["C", "Am", "F", "G"]);

    const counts = await call("auto_assign_hands");
    expect(counts).toEqual({ left: 12, right: 16 });
    const left = await call("get_notes", { hand: "left" });
    expect(left.notes.every((n: { pitch: number }) => n.pitch < 60)).toBe(true);

    const after = await call("analyze_harmony", { resolution: "bar" });
    expect(after.weightedByHand).toBe(true);
    expect(chordNames(after)).toEqual(["C", "Am", "F", "G"]);
    expect(await call("render_piano_roll", { startBar: 1, endBar: 1, grid: "1/4" })).toMatch(/E5\s+\|?R/);
  });

  it("keeps painted marks unless overwrite is set, and set_hand can clear", async () => {
    const { notes } = await call("get_notes", { startBar: 1, endBar: 1, lowPitch: "C5" });
    await call("set_hand", { noteIds: [notes[0].id], setTo: "left" });
    await call("auto_assign_hands");
    expect((await call("get_notes", { noteIds: undefined, hand: "left" })).notes.some((n: { id: string }) => n.id === notes[0].id)).toBe(true);
    await call("auto_assign_hands", { overwrite: true });
    expect((await call("get_notes", { hand: "right" })).notes.some((n: { id: string }) => n.id === notes[0].id)).toBe(true);
    const cleared = await call("set_hand", { hand: "right", setTo: null });
    expect(cleared.updated).toBe(16);
    expect((await call("get_project")).tracks[0].hands).toEqual({ left: 12, right: 0, unassigned: 16 });
  });

  it("transforms one hand only", async () => {
    await call("auto_assign_hands");
    await call("transform_notes", { hand: "left", velocity: 50 });
    const { notes } = await call("get_notes", {});
    for (const n of notes) expect(n.velocity === 50).toBe(n.hand === "left");
  });

  it("follows hands that move across the keyboard", () => {
    const n = (pitch: number, tick: number): Note => ({ id: `${pitch}@${tick}`, pitch, tick, duration: 480, velocity: 80 });
    // Bass walks up while the melody climbs high; the hands never cross.
    const notes = [n(36, 0), n(64, 0), n(40, 480), n(67, 480), n(45, 960), n(72, 960), n(52, 1440), n(79, 1440)];
    const hands = assignHands(notes, 480);
    expect(notes.map((x) => hands.get(x))).toEqual(["left", "right", "left", "right", "left", "right", "left", "right"]);
  });

  it("reads hands from conventional track names", () => {
    expect(handFromTrackName("Piano RH")).toBe("right");
    expect(handFromTrackName("Left Hand")).toBe("left");
    expect(handFromTrackName("Treble")).toBe("right");
    expect(handFromTrackName("Bass Guitar")).toBe(null);
  });
});

describe("appearance", () => {
  it("applies presets and overrides, and survives undo", async () => {
    const look = await call("set_appearance", { preset: "aurora", glow: 0.2 });
    expect(look).toMatchObject({ noteStyle: "neon", colorBy: "hand", glow: 0.2, keyEdgeColor: "#2dd4bf" });
    const mid = await call("set_appearance", { leftHandColor: "#ff00aa", noteLabels: true });
    expect(mid.handColors.left).toBe("#ff00aa");
    expect(mid.glow).toBe(0.2);
    // Appearance isn't an undo step: undo reverts the last *musical* change and keeps the look.
    await call("add_notes", { notes: [{ pitch: "C6", beat: 0 }] });
    await call("undo");
    expect((await call("get_project")).appearance.handColors.left).toBe("#ff00aa");
    await expect(call("set_appearance", { keyEdgeColor: "blue" })).rejects.toThrow(/hex/);
  });
});
