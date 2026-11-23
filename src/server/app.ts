import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ClientMessage, ServerMessage } from "../shared/types";
import { ProjectStore } from "./store";
import { runCommand, type CommandContext } from "./commands";
import { createMcpServer } from "./mcp";
import { midiToProject, projectToMidi } from "./midi-io";

export interface AppOptions {
  dataDir: string | null;
  staticDir?: string;
}

export function createApp(opts: AppOptions) {
  const store = new ProjectStore(opts.dataDir ? path.join(opts.dataDir, "projects") : null);
  const ctx: CommandContext = { store, exportDir: path.join(opts.dataDir ?? process.cwd(), "exports") };
  const app = express();

  // ---- MCP (Streamable HTTP, stateless: a fresh server per request) ----
  app.post("/mcp", express.json({ limit: "50mb" }), async (req, res) => {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[midiom] MCP error", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ---- REST: file import/export (binary payloads don't fit nicely over WS) ----
  app.post("/api/import", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
    try {
      const name = String(req.query.name ?? "Imported").replace(/\.midi?$/i, "");
      const project = midiToProject(new Uint8Array(req.body), name);
      store.add(project);
      store.logActivity({ source: "user", tool: "import_midi", summary: `Imported “${name}”`, ok: true });
      res.json({ projectId: project.id });
    } catch (e) {
      res.status(400).json({ error: `Could not read MIDI file: ${(e as Error).message}` });
    }
  });

  app.get("/api/projects/:id/midi", (req, res) => {
    const p = store.get(req.params.id);
    if (!p) return void res.status(404).end();
    const filename = `${p.name.replace(/[^\w\- ]+/g, "_") || "midiom"}.mid`;
    res.setHeader("Content-Type", "audio/midi");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(projectToMidi(p)));
  });

  app.get("/api/health", (_req, res) => void res.json({ ok: true }));

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get(/^\/(?!api|mcp|ws).*/, (_req, res) => res.sendFile(path.join(opts.staticDir!, "index.html")));
  }

  // ---- WebSocket: live sync with the editor ----
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };

  const projectMsg = (id: string): ServerMessage => ({ type: "project", project: store.get(id)!, canUndo: store.canUndo(id), canRedo: store.canRedo(id) });

  store.on("project", (p) => broadcast(projectMsg(p.id)));
  store.on("projects", (projects) => broadcast({ type: "projects", projects }));
  store.on("active", (projectId) => broadcast({ type: "active", projectId }));
  store.on("activity", (event) => broadcast({ type: "activity", event }));
  store.on("playback", (action, tick) => broadcast({ type: "playback", action, tick }));
  store.on("select", (noteIds) => broadcast({ type: "select", noteIds }));

  wss.on("connection", (ws) => {
    send(ws, { type: "hello", projects: store.list(), activeProjectId: store.activeProjectId, activity: store.activity.slice(-30) });
    if (store.activeProjectId) send(ws, projectMsg(store.activeProjectId));

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "open":
            store.setActive(msg.projectId || null);
            break;
          case "selection":
            store.setSelection({ projectId: store.activeProjectId, noteIds: msg.noteIds, range: msg.range });
            break;
          case "playback":
            store.setPlayback({ playing: msg.playing, tick: msg.tick });
            break;
          case "command": {
            const result = await runCommand(ctx, msg.name, msg.args, "user");
            if (msg.requestId) send(ws, { type: "result", requestId: msg.requestId, result });
            break;
          }
        }
      } catch (e) {
        send(ws, { type: "error", message: (e as Error).message, requestId: msg.type === "command" ? msg.requestId : undefined });
      }
    });
  });

  return { app, server, store, ctx };
}
