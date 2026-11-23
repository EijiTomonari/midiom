// A stdio bridge for MCP clients that only speak stdio (e.g. Claude Desktop).
// It forwards every tool call to the running midiom server over HTTP, so the
// agent and the browser editor share the same live project.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_INSTRUCTIONS } from "./mcp";

const url = new URL(process.env.MIDIOM_URL ?? `http://localhost:${process.env.MIDIOM_PORT ?? 5174}/mcp`);

async function upstream() {
  const client = new Client({ name: "midiom-stdio-bridge", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

const notRunning = `Could not reach the midiom editor at ${url.origin}. Ask the user to start it with \`npm start\` (or \`npm run dev\`) in the midiom folder.`;

const server = new Server({ name: "midiom", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const client = await upstream();
  try {
    return await client.listTools();
  } finally {
    await client.close();
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let client: Client;
  try {
    client = await upstream();
  } catch {
    return { isError: true, content: [{ type: "text", text: notRunning }] };
  }
  try {
    return await client.callTool(req.params);
  } finally {
    await client.close();
  }
});

await server.connect(new StdioServerTransport());
