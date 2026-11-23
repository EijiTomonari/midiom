import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { commands, runCommand, type CommandContext } from "./commands";

export const MCP_INSTRUCTIONS = `midiom is a MIDI editor the user has open in their browser. Every change you make appears live in their editor, and they can undo it.

How to work:
- Call get_project first: it gives tempo, meter, key, length and each track's instrument, range and role.
- Times are in beats (quarter notes) from the start of the song: beat 0 is bar 1 beat 1, and in 4/4 bar N starts at beat (N-1)*4. Outputs also include pos as bar.beat (1-based).
- Pitches are MIDI numbers (60 = C4 = middle C) or names like "F#3".
- To understand music: render_piano_roll to see it, analyze_harmony for key and chords, get_notes for exact values and ids.
- When the user says "this", "these notes" or "here", call get_editor_state to see their selection and playhead.
- Prefer batched edits (one add_notes with many notes) over many small calls. Use highlight_notes to point things out, and play to let the user hear a passage.`;

export function createMcpServer(ctx: CommandContext): McpServer {
  const server = new McpServer({ name: "midiom", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  for (const cmd of commands) {
    if (cmd.uiOnly) continue;
    server.registerTool(
      cmd.name,
      {
        title: cmd.title,
        description: cmd.description,
        inputSchema: cmd.input,
        annotations: { readOnlyHint: !!cmd.readOnly, destructiveHint: cmd.name.startsWith("delete") },
      },
      async (args: unknown) => {
        try {
          const data = await runCommand(ctx, cmd.name, args, "agent");
          const text = typeof data === "string" ? data : JSON.stringify(data);
          return { content: [{ type: "text" as const, text }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
        }
      },
    );
  }
  return server;
}
