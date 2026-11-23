import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app";

let app: ReturnType<typeof createApp>;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

beforeAll(async () => {
  app = createApp({ dataDir: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const { port } = app.server.address() as AddressInfo;
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterAll(async () => {
  await client.close();
  app.server.close();
});

describe("MCP server", () => {
  it("lists tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["get_project", "get_notes", "add_notes", "transform_notes", "analyze_harmony", "render_piano_roll", "get_editor_state", "undo"]) {
      expect(names).toContain(n);
    }
  });

  it("explains when no project is open", async () => {
    await expect(call("get_project")).rejects.toThrow(/No project is open/);
  });

  it("creates a project, writes a progression and understands it", async () => {
    const created = await call("create_project", { name: "Test", bpm: 100 });
    expect(app.store.activeProjectId).toBe(created.id);
    const chord = (root: string[], beat: number) => root.map((pitch) => ({ pitch, beat, duration: 4 }));
    const { noteIds } = await call("add_notes", {
      notes: [...chord(["C3", "E3", "G3"], 0), ...chord(["A2", "C3", "E3"], 4), ...chord(["F2", "A2", "C3"], 8), ...chord(["G2", "B2", "D3", "F3"], 12)],
    });
    expect(noteIds).toHaveLength(13);

    const harmony = await call("analyze_harmony", { resolution: "bar" });
    expect(harmony.chords.map((c: { chord: string }) => c.chord)).toEqual(["C", "Am", "F", "G7"]);
    expect(harmony.detectedKeys[0].key).toBe("C major");

    const overview = await call("get_project");
    expect(overview.length.bars).toBe(4);
    expect(overview.tracks[0].role).toBe("chordal");

    const roll = await call("render_piano_roll", { startBar: 1, endBar: 2, grid: "1/4" });
    expect(roll).toContain("G3");
  });

  it("edits notes, and undo restores them", async () => {
    const before = await call("get_notes", { startBar: 1, endBar: 1 });
    await call("transform_notes", { startBeat: 0, endBeat: 4, transpose: 12 });
    const after = await call("get_notes", { startBar: 1, endBar: 1 });
    expect(after.notes.map((n: { pitch: number }) => n.pitch)).toEqual(before.notes.map((n: { pitch: number }) => n.pitch + 12));
    await call("undo");
    const restored = await call("get_notes", { startBar: 1, endBar: 1 });
    expect(restored.notes).toEqual(before.notes);
  });

  it("refuses to touch every note without an explicit filter", async () => {
    await expect(call("delete_notes", {})).rejects.toThrow(/No notes targeted/);
  });

  it("sees the user's selection", async () => {
    const { notes } = await call("get_notes", { startBar: 2, endBar: 2 });
    app.store.setSelection({ projectId: app.store.activeProjectId, noteIds: notes.map((n: { id: string }) => n.id) });
    const state = await call("get_editor_state");
    expect(state.selectedNotes).toHaveLength(3);
    await call("transform_notes", { useSelection: true, velocity: 40 });
    const edited = await call("get_notes", { useSelection: true });
    expect(edited.notes.every((n: { velocity: number }) => n.velocity === 40)).toBe(true);
  });

  it("copies a phrase and quantizes", async () => {
    const { trackId } = await call("add_track", { name: "Melody", program: 73 });
    await call("add_notes", { trackId, notes: [{ pitch: "E5", beat: 0.07, duration: 0.5 }, { pitch: "D5", beat: 0.48, duration: 0.5 }] });
    await call("quantize_notes", { trackId, grid: 0.5 });
    const q = await call("get_notes", { trackId });
    expect(q.notes.map((n: { beat: number }) => n.beat)).toEqual([0, 0.5]);
    await call("copy_notes", { trackId, all: true, offsetBeats: 4, times: 3 });
    const copied = await call("get_notes", { trackId });
    expect(copied.total).toBe(8);
    expect(copied.notes.at(-1).pos).toBe("4.1.5");
  });
});
