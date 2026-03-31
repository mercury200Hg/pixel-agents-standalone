import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import { randomUUID } from "crypto";
import type { TrackedAgent, ServerMessage, PendingApproval, RiskLevel } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 3_600_000; // 1 hour

// State
const agents = new Map<string, TrackedAgent>(); // sessionId -> agent
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory
const persistDir = join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();
const persistedSeats = loadPersistedSeats();

// Approval system state
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 3_600_000; // 1 hour

const DESTRUCTIVE_PATTERNS = [
  /\brm\s/, /\brmdir\s/, /\bkill\s/, /\bpkill\s/,
  /\bgit\s+push\s+--force/, /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[fd]/, /\bDROP\s/i, /\bDELETE\s+FROM/i,
  /\btruncate\s/i, /\bmkfs\b/, /\bdd\s/,
  /\bgit\s+branch\s+-D/,
];

const READING_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

function classifyRisk(tool: string, input: Record<string, unknown>): RiskLevel {
  if (READING_TOOLS.has(tool)) return "read";
  if (tool === "Bash") {
    const cmd = (input.command as string) || "";
    if (DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd))) return "destructive";
  }
  return "write";
}

function summarizeTool(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash": {
      const cmd = (input.command as string) || "";
      return `Run: ${cmd.slice(0, 80)}${cmd.length > 80 ? "..." : ""}`;
    }
    case "Read":
      return `Read: ${basename(String(input.file_path || ""))}`;
    case "Edit":
      return `Edit: ${basename(String(input.file_path || ""))}`;
    case "Write":
      return `Write: ${basename(String(input.file_path || ""))}`;
    case "Grep":
      return `Search: "${input.pattern}" in ${basename(String(input.path || "."))}`;
    case "Glob":
      return `Find: ${input.pattern}`;
    case "Agent":
      return `Spawn agent: ${String(input.description || "").slice(0, 60)}`;
    default:
      return `${tool}: ${JSON.stringify(input).slice(0, 60)}`;
  }
}

// Express app
const app = express();
app.use(express.json());
// Serve production build
app.use(express.static(join(__dirname, "public")));

// Debug endpoint — list active agents (helps verify session IDs)
app.get("/api/agents", (_req, res) => {
  const list = Array.from(agents.values()).map((a) => ({
    id: a.id,
    sessionId: a.sessionId,
    projectName: a.projectName,
  }));
  res.json(list);
});

// Approval endpoint — long-polls until user responds in the web UI
app.post("/api/approve", (req, res) => {
  const { sessionId, tool, input } = req.body || {};
  if (!sessionId || !tool) {
    res.status(400).json({ error: "Missing sessionId or tool" });
    return;
  }

  // Find agent by sessionId — try exact match first, then prefix match
  let agent = agents.get(sessionId);
  if (!agent) {
    for (const [key, a] of agents) {
      if (key.startsWith(sessionId) || sessionId.startsWith(key)) {
        agent = a;
        break;
      }
    }
  }

  if (!agent) {
    console.warn(`[Approval] No agent found for sessionId: ${sessionId}`);
  }

  const agentId = agent?.id ?? 0;
  const toolInput = (input || {}) as Record<string, unknown>;
  const riskLevel = classifyRisk(tool, toolInput);
  const summary = summarizeTool(tool, toolInput);
  const requestId = randomUUID();

  // Keep the connection alive for long-polling
  req.socket?.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  let resolved = false;

  const pending: PendingApproval = {
    requestId,
    agentId,
    sessionId,
    tool,
    input: toolInput,
    summary,
    riskLevel,
    resolve: (decision) => {
      if (resolved) return;
      resolved = true;
      pendingApprovals.delete(requestId);
      clearTimeout(timer);
      broadcast({ type: "approvalResolved", requestId, decision: decision.decision });
      res.end(JSON.stringify(decision));
    },
    createdAt: Date.now(),
  };

  pendingApprovals.set(requestId, pending);

  // Broadcast to all connected browser clients
  broadcast({
    type: "approvalRequest",
    requestId,
    agentId,
    tool,
    summary,
    riskLevel,
    fullInput: toolInput,
  });

  console.log(`[Approval] ${agent?.projectName || sessionId.slice(0, 8)} requesting: ${summary} (${riskLevel})`);

  // Timeout: auto-deny after 1 hour
  const timer = setTimeout(() => {
    if (!resolved) {
      pending.resolve({ decision: "deny", scope: "once" });
      console.log(`[Approval] Timed out: ${requestId}`);
    }
  }, APPROVAL_TIMEOUT_MS);

  // Clean up if the hook process disconnects (e.g., killed)
  res.on("close", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      pendingApprovals.delete(requestId);
      broadcast({ type: "approvalResolved", requestId, decision: "deny" });
      console.log(`[Approval] Client disconnected: ${requestId}`);
    }
  });
});

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  // Send existing agents with persisted seat metadata
  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta }));

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }

  // Send any pending approvals so a newly opened browser can act on them
  if (pendingApprovals.size > 0) {
    const approvals = Array.from(pendingApprovals.values()).map((p) => ({
      requestId: p.requestId,
      agentId: p.agentId,
      tool: p.tool,
      summary: p.summary,
      riskLevel: p.riskLevel,
      fullInput: p.input,
    }));
    ws.send(JSON.stringify({ type: "pendingApprovals", approvals }));
  }
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "approvalResponse") {
        const { requestId, decision, scope } = msg;
        const pending = pendingApprovals.get(requestId);
        if (pending) {
          pending.resolve({ decision, scope: scope || "once" });
          console.log(`[Approval] ${decision} (${scope}) for: ${pending.summary}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// Watcher
const watcher = new JsonlWatcher();

watcher.on("fileAdded", (file: WatchedFile) => {
  if (agents.has(file.sessionId)) return;
  lastActivityTime = Date.now();

  const agent: TrackedAgent = {
    id: nextAgentId++,
    sessionId: file.sessionId,
    projectDir: dirname(file.path),
    projectName: file.projectName,
    jsonlFile: file.path,
    fileOffset: 0,
    lineBuffer: "",
    activity: "idle",
    activeTools: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastActivityTime: Date.now(),
  };

  agents.set(file.sessionId, agent);
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
  console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
});

watcher.on("fileRemoved", (file: WatchedFile) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;

  agents.delete(file.sessionId);
  broadcast({ type: "agentClosed", id: agent.id });
  console.log(`Agent ${agent.id} left: ${agent.projectName}`);
});

watcher.on("line", (file: WatchedFile, line: string) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  lastActivityTime = Date.now();

  processTranscriptLine(line, agent, broadcast);
});

// Start
watcher.start();
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  console.log(`Watching ~/.claude/projects/ for active sessions...`);
});

// Idle shutdown
setInterval(() => {
  if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    watcher.stop();
    server.close();
    process.exit(0);
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.close();
  process.exit(0);
});
