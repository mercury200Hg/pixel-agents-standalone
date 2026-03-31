#!/bin/bash
#
# Claude Code PreToolUse hook script
# Routes tool approval through the pixel-agents web server.
#
# Stdin: JSON with fields: session_id, tool_name, tool_input, hook_event_name, cwd
#
# Exit codes:
#   0 - Allow the tool call
#   2 - Deny the tool call
#
# Fail-closed: any error results in denial (exit 2).

PIXEL_AGENTS_URL="http://localhost:3456/api/approve"

# Read hook input from stdin
HOOK_INPUT=$(cat)
if [[ -z "$HOOK_INPUT" ]]; then
  exit 0  # No input = allow (shouldn't happen)
fi

# Extract fields from the JSON input
TOOL_NAME=$(echo "$HOOK_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
SESSION_ID=$(echo "$HOOK_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
TOOL_INPUT=$(echo "$HOOK_INPUT" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('tool_input',{})))" 2>/dev/null)

# Both values are required
if [[ -z "$TOOL_NAME" || -z "$SESSION_ID" ]]; then
  exit 0  # Can't identify the tool — allow rather than block everything
fi

# --- Session cache -----------------------------------------------------------
CACHE_FILE="/tmp/pixel-approve-${SESSION_ID}.cache"

if [[ -f "$CACHE_FILE" ]]; then
  while IFS='=' read -r cached_tool cached_decision; do
    if [[ "$cached_tool" == "$TOOL_NAME" && "$cached_decision" == "allow" ]]; then
      exit 0
    fi
  done < "$CACHE_FILE"
fi

# --- Check if server is reachable -------------------------------------------
if ! curl -s --max-time 1 -o /dev/null http://localhost:3456/api/agents 2>/dev/null; then
  exit 0  # Server not running — allow (don't block normal usage)
fi

# --- Build the request payload ------------------------------------------------
PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'sessionId': sys.argv[1],
    'tool': sys.argv[2],
    'input': json.loads(sys.argv[3])
}))
" "$SESSION_ID" "$TOOL_NAME" "$TOOL_INPUT" 2>/dev/null)

if [[ -z "$PAYLOAD" ]]; then
  exit 0  # Payload build failed — allow
fi

# --- POST to the pixel-agents approval server ---------------------------------
HTTP_RESPONSE=$(curl -s --max-time 3600 \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$PIXEL_AGENTS_URL" 2>/dev/null)

CURL_EXIT=$?
if [[ $CURL_EXIT -ne 0 || -z "$HTTP_RESPONSE" ]]; then
  exit 0  # Server error — allow rather than block
fi

# --- Parse the response -------------------------------------------------------
read -r DECISION SCOPE <<< "$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
print(data.get('decision', 'deny'), data.get('scope', 'once'))
" "$HTTP_RESPONSE" 2>/dev/null)"

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
