# Plan: Hook-Based Approval System for Pixel Agents

## Overview

Route all Claude Code permission prompts through the pixel-agents web UI. Users approve or deny tool calls by clicking buttons on each agent's character bubble — replacing terminal-based permission prompts entirely.

## Architecture

```
Claude Code wants to run Edit("server/index.ts", ...)
  |
  v
Claude Code harness fires PreToolUse hook (deterministic, not LLM)
  |
  v
approve-hook.sh runs:
  curl POST http://localhost:3456/api/approve
    { sessionId, tool: "Edit", input: { file_path: "server/index.ts", ... } }
  |
  v
Pixel-agents server:
  - Stores pending approval in Map<requestId, { resolve, reject, agentId, ... }>
  - Broadcasts to browser via WebSocket:
    { type: "approvalRequest", agentId: 3, requestId: "abc",
      tool: "Edit", summary: "Edit: server/index.ts" }
  - Holds HTTP connection open (long-poll)
  |
  v
Browser UI:
  - Shows contextual bubble on agent character: "Edit: server/index.ts"
  - Color-coded: red (destructive), amber (write), blue (read)
  - Buttons: [Allow] [Deny] [Allow for session]
  |
  v
User clicks Allow
  |
  v
Browser sends WebSocket: { type: "approvalResponse", requestId: "abc", decision: "allow" }
  |
  v
Server resolves the held HTTP response: { decision: "allow" }
  |
  v
approve-hook.sh receives response, exits 0 (allow)
  |
  v
Claude Code proceeds with the tool call
```

## Why hooks, not MCP

An MCP-based approval gate relies on Claude **voluntarily** calling a tool before acting. This is a soft control on a non-deterministic system. Failure modes include:

- Auto-compaction drops the MCP instruction from context
- Subagents spawn with fresh context and miss the instruction
- Claude rationalizes "this is safe, I'll skip approval"
- Prompt injection via file content tells Claude to skip the gate
- Claude calls the MCP tool with a misleading description
- Claude executes first, asks after

Hooks are enforced by the **harness**, not by Claude. Claude cannot skip, forget, or rationalize around them. They are deterministic, immune to compaction/hallucination/injection, and apply to all agents and subagents automatically.

## Components

### 1. Hook script (`scripts/approve-hook.sh`)

A bash script that Claude Code's harness runs before every tool call.

**Inputs (from Claude Code harness):**
- `CLAUDE_TOOL_NAME` env var — tool name (Bash, Read, Edit, Write, Grep, etc.)
- Tool input JSON — piped via stdin
- `CLAUDE_SESSION_ID` env var — identifies the agent session

**Behavior:**
- POSTs tool details to pixel-agents server
- Long-polls waiting for user decision (1 hour timeout)
- On timeout or server unreachable: **deny** (fail-closed)
- On response: exit 0 (allow) or exit 2 (deny)

**Optional local caching:**
- "Allow for session" decisions cached in a temp file (`/tmp/pixel-approve-$SESSION_ID.cache`)
- On subsequent calls, script checks cache before hitting server
- Cache entries keyed by tool name (e.g., `Read=allow`, `Bash=prompt`)
- Cache cleared when session ends

```bash
#!/bin/bash
PIXEL_AGENTS_URL="http://localhost:3456/api/approve"

INPUT=$(cat)

# Check local cache for "allow for session" decisions
CACHE_FILE="/tmp/pixel-approve-${CLAUDE_SESSION_ID}.cache"
if [ -f "$CACHE_FILE" ]; then
  CACHED=$(grep "^${CLAUDE_TOOL_NAME}=" "$CACHE_FILE" 2>/dev/null | cut -d= -f2)
  if [ "$CACHED" = "allow" ]; then
    exit 0
  fi
fi

# POST to pixel-agents server, wait up to 1hr
RESPONSE=$(curl -s --max-time 3600 \
  -X POST "$PIXEL_AGENTS_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$CLAUDE_SESSION_ID\",
    \"tool\": \"$CLAUDE_TOOL_NAME\",
    \"input\": $INPUT
  }" 2>/dev/null)

if [ $? -ne 0 ]; then
  exit 2  # fail-closed
fi

DECISION=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','deny'))" 2>/dev/null)
SCOPE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('scope','once'))" 2>/dev/null)

# Cache "allow for session" decisions
if [ "$DECISION" = "allow" ] && [ "$SCOPE" = "session" ]; then
  echo "${CLAUDE_TOOL_NAME}=allow" >> "$CACHE_FILE"
fi

if [ "$DECISION" = "allow" ]; then
  exit 0
else
  exit 2
fi
```

### 2. Server endpoint (`server/index.ts`)

New HTTP routes added to the existing Express server.

**State:**
```typescript
interface PendingApproval {
  requestId: string;
  agentId: number;           // pixel-agent character ID
  sessionId: string;         // Claude session UUID
  tool: string;              // "Bash", "Edit", etc.
  input: Record<string, unknown>;  // tool input JSON
  summary: string;           // human-readable: "Edit: server/index.ts"
  riskLevel: "read" | "write" | "destructive";
  resolve: (decision: { decision: string; scope: string }) => void;
  createdAt: number;
}

const pendingApprovals = new Map<string, PendingApproval>();
```

**Routes:**

`POST /api/approve`
- Receives: `{ sessionId, tool, input }`
- Looks up agent by sessionId to get agentId
- Generates requestId (UUID)
- Classifies risk level:
  - `read`: Read, Grep, Glob, WebFetch, WebSearch
  - `destructive`: Bash commands matching `rm`, `rmdir`, `kill`, `git push --force`, `git reset --hard`, `DROP`, `DELETE FROM`
  - `write`: everything else (Edit, Write, Bash non-destructive)
- Generates summary string from tool + input (templates, not LLM)
- Stores in `pendingApprovals` map
- Broadcasts `approvalRequest` to browser via WebSocket
- Holds HTTP connection open until resolved or timeout
- On 1hr timeout: responds `{ decision: "deny", scope: "once" }`

**Summary templates:**
```
Bash     → "Run: {first 80 chars of command}"
Read     → "Read: {file_path basename}"
Edit     → "Edit: {file_path basename}"
Write    → "Write: {file_path basename}"
Grep     → "Search: \"{pattern}\" in {path basename}"
Glob     → "Find: {pattern}"
Agent    → "Spawn agent: {description first 60 chars}"
```

**Risk classification for Bash commands:**
```typescript
const DESTRUCTIVE_PATTERNS = [
  /\brm\s/,  /\brmdir\s/,  /\bkill\s/,  /\bpkill\s/,
  /\bgit\s+push\s+--force/,  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[fd]/,  /\bDROP\s/i,  /\bDELETE\s+FROM/i,
  /\btruncate\s/i,  /\bmkfs\b/,  /\bdd\s/,
  />\s*\/(?!tmp|dev\/null)/,  // redirect overwrite to non-tmp paths
];
```

### 3. WebSocket messages (`server/types.ts`)

New message types added to the existing ServerMessage union:

**Server -> Client:**
```typescript
| { type: "approvalRequest";
    requestId: string;
    agentId: number;
    tool: string;
    summary: string;
    riskLevel: "read" | "write" | "destructive";
    fullInput: Record<string, unknown>;  // for detail view
  }
| { type: "approvalResolved";
    requestId: string;
    decision: "allow" | "deny";
  }
```

**Client -> Server (via WebSocket message handler):**
```typescript
{ type: "approvalResponse";
  requestId: string;
  decision: "allow" | "deny";
  scope: "once" | "session";  // "session" = don't ask again for this tool type
}
```

### 4. Browser UI (`webview-ui/`)

**Approval bubble (replaces generic "Needs approval"):**

- Rendered in `ToolOverlay.tsx` when an agent has a pending approval
- Shows:
  - Tool summary text: `"Run: npm test"`
  - Risk-colored border/background:
    - Blue (#3794ff) for read operations
    - Amber (#cca700) for write operations
    - Red (#f44747) for destructive operations
  - Three buttons: `[Allow]` `[Deny]` `[Allow for session]`
- Clicking a button sends `approvalResponse` via WebSocket
- Multiple concurrent approvals stack vertically

**Approval state in hooks (`useExtensionMessages.ts`):**

- New state: `pendingApprovals: Map<string, ApprovalRequest>`
- On `approvalRequest` message: add to map, show bubble
- On `approvalResolved` message: remove from map, clear bubble

**Approval queue panel (optional, future):**

- A sidebar or bottom panel listing all pending approvals across agents
- Allows batch approve/deny
- Shows timestamp and how long each request has been waiting

### 5. Hook configuration

**Project-level** (`.claude/settings.json` in the workspace):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "/absolute/path/to/pixel-agents-standalone/scripts/approve-hook.sh"
      }
    ]
  }
}
```

Place this in:
```
~/Documents/Projects/github/quizfirst/quizfirst-workspace/.claude/settings.json
```

This automatically applies to all agents and subagents running in that project. No per-agent configuration needed.

**Alternative — global config** (`~/.claude/settings.json`):

Same structure but applies to ALL Claude Code sessions on the machine. Use project-level unless you want every project routed through pixel-agents.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Pixel-agents server not running | curl fails, hook exits 2 (deny). Fail-closed. |
| Browser disconnected (no UI to approve) | Request sits until timeout (1hr), then auto-deny. |
| Multiple agents request approval simultaneously | Each gets its own pending entry; UI shows all bubbles. |
| User closes browser tab mid-approval | WebSocket disconnects, requests stay pending in server. Next browser connection sees them. |
| Server restarts mid-approval | Pending map lost, curl gets connection error, hook denies. Agent retries on next attempt. |
| "Allow for session" then server restarts | Local cache file (`/tmp/pixel-approve-*`) persists. Previously allowed tools continue without prompting. |
| Hook script not executable | Claude Code reports hook error. Fix with `chmod +x`. |
| Very large tool input (e.g., Write with big file content) | Summary uses template (basename only). Full input available in detail view but not shown by default. |

## Implementation Order

1. **Server endpoint** — `POST /api/approve` with pending map and long-poll resolution
2. **WebSocket messages** — broadcast approval requests, handle responses
3. **Hook script** — `scripts/approve-hook.sh` with caching
4. **Browser UI** — approval bubbles with contextual info and buttons
5. **Risk classification** — color coding and destructive pattern detection
6. **Testing** — manual test with a real Claude Code session

## Estimated Effort

| Component | Time |
|---|---|
| Server endpoint + state management | 1 day |
| WebSocket message types + handlers | 0.5 day |
| Hook script with caching | 0.5 day |
| Browser UI (bubbles, buttons, styling) | 1.5 days |
| Integration testing + edge cases | 0.5 day |
| **Total** | **~4 days** |

## Future Enhancements (Not in scope)

- Approval queue sidebar for batch approve/deny
- Text-to-speech announcements for approval requests
- Approval audit log (who approved what, when)
- Rule engine: auto-approve certain patterns (e.g., `npm test` always allowed)
- Mobile-friendly approval UI for remote monitoring
