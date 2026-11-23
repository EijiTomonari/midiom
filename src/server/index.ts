import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.MIDIOM_PORT ?? 5174);
const dataDir = process.env.MIDIOM_DATA_DIR ?? path.join(os.homedir(), ".midiom");
const production = process.env.NODE_ENV === "production";

const { server, store } = createApp({ dataDir, staticDir: production ? path.join(root, "dist") : undefined });

server.listen(port, "127.0.0.1", () => {
  const ui = production ? `http://localhost:${port}` : "http://localhost:5173";
  console.log(`\n  midiom`);
  console.log(`  ├─ editor:     ${ui}`);
  console.log(`  ├─ MCP server: http://localhost:${port}/mcp`);
  console.log(`  └─ data:       ${dataDir}\n`);
});

const shutdown = () => {
  store.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
