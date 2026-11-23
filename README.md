# midiom

An AI-first MIDI editor. You see your music as notes falling onto a piano keyboard and edit it with the mouse, and an agent like Claude can read and edit the same project through a built-in **MCP server**. Every change the agent makes shows up live in your editor, and you can undo it.

## Quick start

```bash
npm install
npm run dev        # editor on http://localhost:5173, MCP server on http://localhost:5174/mcp
```

For a single-port production build:

```bash
npm run build
npm start          # editor + MCP on http://localhost:5174
```

Projects are saved as JSON in `~/.midiom` (set `MIDIOM_DATA_DIR` to change it). Set `MIDIOM_PORT` to change the server port.

## Using the editor

- **New project** or **Open MIDI file** (or drop a `.mid` file anywhere on the start screen).
- **Double-click** to add a note on the selected track. **Drag** to move a note, or drag its top edge to change its length.
- **Drag on empty space** to box-select. **Shift-click** adds to the selection.
- **Space** plays or pauses. **Scroll** moves through time; **⌘/Ctrl + scroll** zooms.
- With notes selected: **↑/↓** transpose (Shift = octave), **←/→** move by the grid, **Q** quantize, **⌘D** duplicate, **Delete** removes them.
- **Hands:** pick the **L** or **R** brush (or press `L` / `R`) and drag across notes to mark which hand plays them. **⌀** (`E`) clears a mark, **Auto** guesses hands for any unmarked notes, and **Colors** shows notes in hand colors (blue = left, green = right). With notes selected, **⇧L / ⇧R** marks them. Tracks named like "Piano RH" or "Left Hand" are marked automatically when you import a MIDI file.
- **Look:** choose a preset (Classic, Neon blue, Aurora, Synthwave) or tune it yourself. You can color notes by track or by hand and pick any color. Note style is solid, neon outline or glass. You can also set glow, particles rising from the keys, keys that light up, the color of the keyboard's top edge (it can flare in each note's color), note names and the background. Click a track's color strip to recolor it. The look is saved with the project and is not part of undo.
- **Sustain pedal:** the narrow lane on the left of the notes shows the selected track's pedal. Drag in it to add a press, drag a press to move it, drag its top edge to resize it, and double-click to remove it. **Auto pedal** re-pedals at every chord change. Pedal from imported MIDI files (CC64) is kept, and it's exported again.
- **⌘Z / ⇧⌘Z** undo and redo. The agent's edits are on the same undo history as yours.
- **Export** downloads a `.mid` file.

## Connecting an agent

Start midiom first, then connect your agent:

| Client | How |
| --- | --- |
| Claude Code (inside this repo) | Already configured in `.mcp.json`. |
| Claude Code (elsewhere) | `claude mcp add --transport http midiom http://localhost:5174/mcp` |
| Claude Desktop / stdio clients | `{"command": "npx", "args": ["-y", "mcp-remote", "http://localhost:5174/mcp"]}`, or run `npm run mcp:stdio` from this folder |

The **✦ Agent** button in the editor shows these with copy buttons.

### MCP tools

| Area | Tools |
| --- | --- |
| Understand | `get_project` (tempo, meter, key, tracks with range/role), `get_notes`, `render_piano_roll` (text piano roll), `analyze_harmony` (key + chord progression), `get_editor_state` (what the user has selected and where the playhead is) |
| Edit notes | `add_notes`, `update_notes`, `delete_notes`, `transform_notes` (transpose, shift, stretch, velocity, legato, humanize), `quantize_notes`, `copy_notes` |
| Hands | `set_hand`, `auto_assign_hands`, and a `hand` filter on every tool that targets notes ("make the left hand softer") |
| Pedal | `get_pedal`, `add_pedal`, `update_pedal`, `delete_pedal`, `auto_pedal` |
| Look | `set_appearance` (presets plus every visual setting: "make it look like a purple neon video") |
| Tracks & song | `add_track`, `update_track`, `delete_track`, `set_tempo`, `set_time_signature`, `update_project` |
| Projects | `list_projects`, `create_project`, `open_project`, `delete_project`, `import_midi`, `export_midi` |
| Collaborate | `undo`, `redo`, `play`, `stop`, `highlight_notes` |

Marking hands improves chord detection. When hands are marked, `analyze_harmony` counts the left hand fully. A single right-hand melody line counts only 30%, so its passing tones don't turn a C into a Cadd9. Right-hand block chords count 80%.

Conventions for agents: times are in **beats** (quarter notes) from the start of the song, so beat 0 is bar 1 and in 4/4 bar N starts at beat (N−1)×4. Every note in a result also has `pos` as `bar.beat`. Pitches are MIDI numbers or names such as `C4` or `F#3`. Tools that target notes take note ids, `useSelection: true` (the notes the user selected), or a filter. The server rejects an edit with no target unless it has `all: true`, so an agent can't change every note by accident.

## Sound

Piano tracks (GM programs 0–3) play a sampled grand piano: the [Salamander Grand Piano V3](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)). It uses three velocity layers (soft, medium, loud), a sample every minor third, and key-release noises. The top octaves ring on after release because they have no dampers, as on a real piano. The samples are about 8 MB and live in `src/web/public/samples/piano`. They load in the background, and the editor uses the built-in synth until they're ready. `scripts/build-piano-samples.sh` rebuilds them from the source recordings.

Every instrument plays through a light hall reverb. The non-piano instruments still use the built-in synth.

## Architecture

```
src/
  shared/   data model, pitch/time helpers, WebSocket protocol
  server/   project store (persistence + undo), commands, MCP server, MIDI import/export, analysis
  web/      React UI: falling-notes canvas, WebAudio synth and player, track list, agent activity feed
```

The server owns the project state. The MCP tools and the web UI both run the same **commands** (`src/server/commands.ts`), so a person and an agent edit through one code path with one undo history. The server pushes every change to the browser over a WebSocket.

## Development

```bash
npm test           # unit tests + MCP integration tests
npm run typecheck
```
