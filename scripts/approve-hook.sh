#!/bin/bash
#
# Claude Code PreToolUse hook script
# Routes tool approval through the pixel-agents web server.
#
# Environment variables:
#   CLAUDE_TOOL_NAME   - Name of the tool being invoked
#   CLAUDE_SESSION_ID  - Current Claude Code session ID
#
# Stdin: JSON input for the tool (may be empty)
#
# Exit codes:
#   0 - Allow the tool call
#   2 - Deny the tool call
#
# Fail-closed: any error results in denial (exit 2).

set -euo pipefail

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
SESSION_ID="${CLAUDE_SESSION_ID:-}"

# Both values are required
if [[ -z "$TOOL_NAME" || -z "$SESSION_ID" ]]; then
  exit 2
fi

# --- Session cache -----------------------------------------------------------
# The cache stores "allow for session" decisions so we don't re-prompt.
# Format: one TOOLNAME=allow per line.
CACHE_FILE="/tmp/pixel-approve-${SESSION_ID}.cache"

if [[ -f "$CACHE_FILE" ]]; then
  while IFS='=' read -r cached_tool cached_decision; do
    if [[ "$cached_tool" == "$TOOL_NAME" && "$cached_decision" == "allow" ]]; then
      # Tool is already approved for this session
      exit 0
    fi
  done < "$CACHE_FILE"
fi

# --- Read tool input from stdin -----------------------------------------------
# Stdin may be empty; default to an empty JSON object.
INPUT=$(cat)
if [[ -z "$INPUT" ]]; then
  INPUT="{}"
fi

# --- Build the request payload ------------------------------------------------
PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'sessionId': sys.argv[1],
    'tool': sys.argv[2],
    'input': json.loads(sys.argv[3])
}))
" "$SESSION_ID" "$TOOL_NAME" "$INPUT")

# --- POST to the pixel-agents approval server ---------------------------------
HTTP_RESPONSE=$(curl -s -f \
  --max-time 3600 \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "http://localhost:3456/api/approve" 2>/dev/null) || exit 2

# --- Parse the response -------------------------------------------------------
# Expected JSON: { "decision": "allow"|"deny", "scope": "once"|"session" }
read -r DECISION SCOPE <<< "$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
print(data.get('decision', 'deny'), data.get('scope', 'once'))
" "$HTTP_RESPONSE")"

# --- Cache session-scoped allows ----------------------------------------------
if [[ "$SCOPE" == "session" && "$DECISION" == "allow" ]]; then
  echo "${TOOL_NAME}=allow" >> "$CACHE_FILE"
fi

# --- Exit based on decision ---------------------------------------------------
if [[ "$DECISION" == "allow" ]]; then
  exit 0
else
  exit 2
fi
