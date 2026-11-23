import { useState } from "react";

export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const mcpUrl = `${location.protocol}//${location.hostname}:${location.port === "5173" ? "5174" : location.port}/mcp`;
  const claudeCode = `claude mcp add --transport http midiom ${mcpUrl}`;
  const desktop = JSON.stringify({ mcpServers: { midiom: { command: "npx", args: ["-y", "mcp-remote", mcpUrl] } } }, null, 2);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect an agent</h2>
        <p>midiom runs an MCP server. Any agent connected to it can read and edit the project you have open — you'll see every change here, live, and can undo it.</p>
        <h3>Claude Code</h3>
        <Copy text={claudeCode} />
        <h3>Claude Desktop & other stdio clients</h3>
        <p className="muted">Add to your MCP config:</p>
        <Copy text={desktop} />
        <h3>Any MCP client (Streamable HTTP)</h3>
        <Copy text={mcpUrl} />
        <div className="modal-footer">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <pre>{text}</pre>
      <button
        className="ghost small"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
