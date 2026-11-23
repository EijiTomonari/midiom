import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env.MIDIOM_PORT ?? 5174);
const target = `http://localhost:${serverPort}`;

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/mcp": target,
      "/ws": { target: target.replace("http", "ws"), ws: true },
    },
  },
});
