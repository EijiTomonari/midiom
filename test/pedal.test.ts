import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app";
import { emptyProject, midiToProject, newTrack, projectToMidi, pedalFromControlChanges } from "../src/server/midi-io";
import { normalizePedal, pedalReleaseTick } from "../src/shared/music";

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

describe("sustain pedal", () => {
  it("reads CC64 into ranges, including a pedal left down at the end", () => {
    const r = pedalFromControlChanges([
      { ticks: 0, value: 1 }, { ticks: 400, value: 0.9 }, { ticks: 900, value: 0 },
      { ticks: 960, value: 0.6 }, { ticks: 1900, value: 0.2 }, { ticks: 2000, value: 1 },
    ]);
    expect(r.map((x) => [x.tick, x.duration])).toEqual([[0, 900], [960, 940], [2000, 1]]);
  });

  it("survives a MIDI file round trip", () => {
    const p = emptyProject("p");
    const t = newTrack(p);
    t.notes = [{ id: "a", pitch: 60, tick: 0, duration: 240, velocity: 80 }];
    t.pedal = [{ id: "x", tick: 0, duration: 1800 }, { id: "y", tick: 1920, duration: 960 }];
    p.tracks.push(t);
    const back = midiToProject(projectToMidi(p), "p");
    expect(back.tracks[0].pedal!.map((x) => [x.tick, x.duration])).toEqual([[0, 1800], [1920, 960]]);
  });

  it("extends notes released while the pedal is down", () => {
    const pedal = [{ id: "x", tick: 0, duration: 1000 }];
    expect(pedalReleaseTick(pedal, 480)).toBe(1000);
    expect(pedalReleaseTick(pedal, 1200)).toBe(1200);
    expect(normalizePedal([{ id: "a", tick: 0, duration: 100 }, { id: "b", tick: 100, duration: 50 }, { id: "c", tick: 300, duration: 10 }]).map((x) => [x.tick, x.duration])).toEqual([[0, 150], [300, 10]]);
  });

  it("auto-pedals at each chord change", async () => {
    await call("create_project", { name: "Pedal" });
    // Broken-chord accompaniment: C | Am | F | G, eighth notes, released immediately.
    const chords = [["C3", "G3", "E4"], ["A2", "E3", "C4"], ["F2", "C3", "A3"], ["G2", "D3", "B3"]];
    await call("add_notes", { notes: chords.flatMap((c, bar) => [0, 1, 2, 1, 0, 1, 2, 1].map((k, i) => ({ pitch: c[k], beat: bar * 4 + i * 0.5, duration: 0.5 }))) });
    const res = await call("auto_pedal", { resolution: "bar" });
    expect(res.presses).toBe(4);
    const pedal = await call("get_pedal");
    expect(pedal.map((r: { pos: string; upAt: string }) => `${r.pos}→${r.upAt}`)).toEqual(["1.1.13→2.1", "2.1.13→3.1", "3.1.13→4.1", "4.1.13→5.1"]);
    expect(await call("render_piano_roll", { startBar: 1, endBar: 1, grid: "1/8" })).toContain("Ped  v-------");
    expect((await call("get_project")).tracks[0].pedalPresses).toBe(4);
    await call("undo");
    expect(await call("get_pedal")).toEqual([]);
  });

  it("adds, edits and removes presses", async () => {
    await call("add_pedal", { ranges: [{ beat: 0, duration: 3.9 }, { beat: 4, duration: 4 }] });
    let pedal = await call("get_pedal");
    expect(pedal).toHaveLength(2);
    await call("update_pedal", { id: pedal[1].id, duration: 2 });
    pedal = await call("get_pedal");
    expect(pedal[1].duration).toBe(2);
    await call("add_pedal", { ranges: [{ beat: 3.5, duration: 1 }] }); // bridges the gap: all merge
    expect(await call("get_pedal")).toHaveLength(1);
    await call("delete_pedal", {});
    expect(await call("get_pedal")).toEqual([]);
  });
});
