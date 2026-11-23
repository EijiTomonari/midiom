import { describe, expect, it } from "vitest";
import { parsePitch, pitchName, tickToBarBeat, barBeatToTick, ticksToSeconds, secondsToTicks } from "../src/shared/music";
import { emptyProject, midiToProject, newTrack, projectToMidi } from "../src/server/midi-io";
import { detectKey, identifyChord, renderPianoRoll } from "../src/server/analysis";
import type { Note } from "../src/shared/types";

const n = (pitch: number, tick: number, duration = 480): Note => ({ id: `${pitch}-${tick}`, pitch, tick, duration, velocity: 90 });

describe("music helpers", () => {
  it("parses and formats pitches", () => {
    expect(parsePitch("C4")).toBe(60);
    expect(parsePitch("F#3")).toBe(54);
    expect(parsePitch("Bb2")).toBe(46);
    expect(parsePitch("A0")).toBe(21);
    expect(parsePitch(64)).toBe(64);
    expect(pitchName(61)).toBe("C#4");
    expect(() => parsePitch("H2")).toThrow();
  });

  it("converts bars, beats and seconds", () => {
    const p = emptyProject("t", { numerator: 3, denominator: 4, bpm: 120 });
    expect(barBeatToTick(p, 2)).toBe(3 * 480);
    expect(tickToBarBeat(p, 3 * 480 + 240)).toEqual({ bar: 2, beat: 1.5 });
    p.tempos.push({ tick: 960, bpm: 60 });
    expect(ticksToSeconds(p, 960)).toBeCloseTo(1);
    expect(ticksToSeconds(p, 1440)).toBeCloseTo(2);
    expect(secondsToTicks(p, 2)).toBeCloseTo(1440);
  });
});

describe("MIDI import/export", () => {
  it("round-trips notes, tempo and meter", () => {
    const p = emptyProject("Song", { bpm: 96, numerator: 6, denominator: 8 });
    const t = newTrack(p, { name: "Lead", program: 73 });
    t.notes = [n(60, 0), n(64, 480), n(67, 960, 960)];
    p.tracks.push(t);
    const back = midiToProject(projectToMidi(p), "Song");
    expect(back.tempos[0].bpm).toBeCloseTo(96);
    expect(back.timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 });
    expect(back.tracks).toHaveLength(1);
    expect(back.tracks[0].program).toBe(73);
    expect(back.tracks[0].notes.map((x) => [x.pitch, x.tick, x.duration])).toEqual([[60, 0, 480], [64, 480, 480], [67, 960, 960]]);
  });
});

describe("analysis", () => {
  it("detects the key of a C major scale", () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => n(p, i * 480));
    scale.push(n(60, 4000, 1920), n(67, 4000, 960));
    expect(detectKey(scale)[0].key).toBe("C major");
  });

  it("names chords and inversions", () => {
    expect(identifyChord([n(57, 0), n(60, 0), n(64, 0)], 0, 480)?.name).toBe("Am");
    expect(identifyChord([n(55, 0), n(59, 0), n(62, 0), n(65, 0)], 0, 480)?.name).toBe("G7");
    expect(identifyChord([n(52, 0), n(60, 0), n(67, 0)], 0, 480)?.name).toBe("C/E");
  });

  it("renders a text piano roll", () => {
    const p = emptyProject("t");
    const t = newTrack(p);
    t.notes = [n(60, 0, 960), n(62, 960)];
    p.tracks.push(t);
    const roll = renderPianoRoll(p, { startTick: 0, endTick: 1920, stepTicks: 240 });
    expect(roll).toContain("D4   |.:.#=:.");
    expect(roll).toContain("C4   #===:.:.");
  });
});
